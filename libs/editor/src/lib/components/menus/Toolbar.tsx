'use client';
import { getOpenImagePicker } from "../../utils/mediaPicker";

import React from 'react';
import formatHTML from '../../utils/formatHTML';
import type { Editor } from '@tiptap/core';
import { sanitizeAuthoredBlockHtml } from '@nextblock-cms/utils';
import {
  Bold, Italic, Underline, Strikethrough, Code, Link2, Palette,
  Heading1, Heading2, Heading3, List, ListOrdered, CheckSquare,
  TextQuote, Code2, Image, Table2, Minus, AlignLeft, AlignCenter,
  AlignRight, AlignJustify, Subscript, Superscript, Type, Download, AlertTriangle, Megaphone, FileCode2, Eye,
} from 'lucide-react';
import { Button } from '@nextblock-cms/ui/button';
import { Separator } from '@nextblock-cms/ui/separator';
import { Popover, PopoverContent, PopoverTrigger } from '@nextblock-cms/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from '@nextblock-cms/ui/dropdown-menu';
import { UndoRedoButtons } from '../ui/UndoRedoButtons';
import { AdvancedColorMenu } from '../ui/AdvancedColorMenu';
import { AdvancedFontSizeMenu } from '../ui/AdvancedFontSizeMenu';

interface EditorToolbarProps {
  editor: Editor;
}

const ToolbarButton: React.FC<{
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
  ariaLabel?: string;
  shortcut?: string;
}> = ({ onClick, isActive, disabled, children, title, ariaLabel, shortcut }) => {
  const tooltipText = shortcut ? `${title} (${shortcut})` : title;
  
  return (
    <Button
      type="button"
      variant={isActive ? 'default' : 'ghost'}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={tooltipText}
      aria-label={ariaLabel || title}
      className={`h-8 w-8 p-0 transition-all duration-200 ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-accent hover:text-accent-foreground hover:scale-105'
      }`}
    >
      {children}
    </Button>
  );
};

const FontSizePicker: React.FC<{ editor: Editor }> = ({ editor }) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          aria-label="Font size menu"
          title="Font size menu"
        >
          <Type className="h-4 w-4 mr-1" />
          Size
        </Button>
      </PopoverTrigger>
      <PopoverContent
        onFocusOutside={(e: Event) => e.preventDefault()}
        className="w-[360px] p-0"
        side="bottom"
        align="start"
      >
        <AdvancedFontSizeMenu editor={editor} className="p-4" />
      </PopoverContent>
    </Popover>
  );
};

const ColorPicker: React.FC<{ editor: Editor }> = ({ editor }) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label="Color menu"
          title="Color menu"
        >
          <Palette className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        onFocusOutside={(e: Event) => e.preventDefault()}
        className="w-[380px] p-0"
        side="bottom"
        align="start"
      >
        <AdvancedColorMenu editor={editor} className="p-4" />
      </PopoverContent>
    </Popover>
  );
};

const InsertDropdown: React.FC<{ editor: Editor }> = ({ editor }) => {
  const insertImage = async () => {
    const opener = getOpenImagePicker(editor);
    if (opener) {
      const res = await opener();
      if (res?.src) {
        editor.chain().focus().setImage({ src: res.src, alt: res.alt || undefined }).run();
        if (res.blurDataURL) {
          editor.chain().focus().updateAttributes('image', { blurDataURL: res.blurDataURL }).run();
        }
      }
      return;
    }
    const url = window.prompt('Enter image URL:');
    if (url) {
      editor.chain().focus().setImage({ src: url }).run();
    }
  };

  const insertTable = () => {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  const insertLink = () => {
    const url = window.prompt('Enter URL:');
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2">
          Insert
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={insertImage}>
          <Image className="h-4 w-4 mr-2" />
          Image
        </DropdownMenuItem>
        <DropdownMenuItem onClick={insertTable}>
          <Table2 className="h-4 w-4 mr-2" />
          Table
        </DropdownMenuItem>
        <DropdownMenuItem onClick={insertLink}>
          <Link2 className="h-4 w-4 mr-2" />
          Link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="h-4 w-4 mr-2" />
          Horizontal Rule
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            const css = window.prompt('Enter CSS (without <style> tags):', '/* your styles */');
            if (css != null) {
              // Prepend CSS at top of document
              const content = `<style>${css}</style>`;
              editor.commands.insertContentAt({ from: 0, to: 0 }, content);
            }
          }}
        >
          <Code2 className="h-4 w-4 mr-2" />
          CSS Block
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const js = window.prompt('Enter JavaScript (without <script> tags):', '// your script');
            if (js != null) {
              // Append JS at end of document
              const content = `<script>${js}</script>`;
              const end = editor.state.doc.content.size;
              editor.commands.insertContentAt(end, content);
            }
          }}
        >
          <Code2 className="h-4 w-4 mr-2" />
          Script Block
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const className = window.prompt('Optional class for DIV:', '');
            const style = window.prompt('Optional inline style for DIV:', '');
            const text = window.prompt('Optional content for DIV:', 'New block');
            const attrs = `${className ? ` class="${className}"` : ''}${style ? ` style="${style}"` : ''}`;
            const escapeHtml = (s: string) => s
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
            const inner = text ? `<p>${escapeHtml(text)}</p>` : '<p><br /></p>';
            editor.chain().focus().insertContent(`<div${attrs}>${inner}</div>`).run();
          }}
        >
          <Code2 className="h-4 w-4 mr-2" />
          DIV Block
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => editor.chain().focus().setAlertWidget().run()}>
          <AlertTriangle className="h-4 w-4 mr-2" />
          Alert Widget
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            editor
              .chain()
              .focus()
              .setCtaWidget({ text: 'Learn more', url: '', style: 'primary', size: 'medium', textAlign: 'center' })
              .run()
          }
        >
          <Megaphone className="h-4 w-4 mr-2" />
          CTA Widget
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ExportDropdown: React.FC<{ editor: Editor }> = ({ editor }) => {
  const exportHTML = () => {
    const html = editor.getHTML();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJSON = () => {
    const json = JSON.stringify(editor.getJSON(), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportText = () => {
    const text = editor.getText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" aria-label="Export menu" title="Export menu">
          <Download className="h-4 w-4 mr-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={exportHTML}>
          Export as HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportJSON}>
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportText}>
          Export as Text
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const EditorToolbar: React.FC<EditorToolbarProps> = ({ editor }) => {
  // Hooks must be declared unconditionally at the top level
  const [isSourceOpen, setIsSourceOpen] = React.useState(false);
  const [sourceValue, setSourceValue] = React.useState<string>('');
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const previewBlobUrlsRef = React.useRef<string[]>([]);

  // Early return after hooks to satisfy react-hooks/rules-of-hooks
  React.useEffect(() => {
    if (!editor) return;
    const onOpenSource = (_e: Event) => {
      try {
        const raw = editor.getHTML();
        setSourceValue(formatHTML(raw));
        setIsSourceOpen(true);
      } catch { /* ignore */ }
    };
    const evt = 'editor:openSourceView';
    window.addEventListener(evt, onOpenSource);
    return () => window.removeEventListener(evt, onOpenSource);
  }, [editor]);

  if (!editor) {
    return null;
  }

  const openSource = () => {
    const raw = editor.getHTML();
    setSourceValue(formatHTML(raw));
    setIsSourceOpen(true);
  };

  const applySource = () => {
    editor.chain().focus().setContent(sourceValue).run();
    setIsSourceOpen(false);
  };

  const openPreview = () => {
    // cleanup old blob URLs
    for (const u of previewBlobUrlsRef.current) {
      try { URL.revokeObjectURL(u); } catch { /* ignore revoke errors */ }
    }
    previewBlobUrlsRef.current = [];

    // Sanitized like the public render, which never runs authored scripts. The preview is a
    // blob: document: same origin as the CMS, inheriting its CSP (script-src allows blob:), in an
    // iframe that allows scripts and same-origin. Block HTML is WRITER-authored (PostgREST too),
    // and this used to turn its inline scripts into blob: scripts, so clicking Preview ran them
    // with the CMS session of whoever clicked.
    const bodyHTML = sanitizeAuthoredBlockHtml(editor.getHTML());

    const fullDoc = `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Preview</title></head><body>${bodyHTML}</body></html>`;
    const mainBlob = new Blob([fullDoc], { type: 'text/html' });
    const mainUrl = URL.createObjectURL(mainBlob);
    previewBlobUrlsRef.current.push(mainUrl);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(mainUrl);
    setIsPreviewOpen(true);
  };

  return (
    <div className="border-b bg-background p-2 relative">
      <div className="flex items-center gap-1 flex-wrap">
        {/* Enhanced Undo/Redo Component - More prominent placement */}
        <div className="flex items-center gap-1 mr-2 p-1 rounded-md bg-muted/30 border border-border/50">
          <UndoRedoButtons editor={editor} size="sm" showLabels={false} />
        </div>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Headings */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive('heading', { level: 1 })}
          title="Heading 1"
        >
          <Heading1 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive('heading', { level: 2 })}
          title="Heading 2"
        >
          <Heading2 className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive('heading', { level: 3 })}
          title="Heading 3"
        >
          <Heading3 className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Basic formatting */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive('bold')}
          title="Bold"
        >
          <Bold className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive('italic')}
          title="Italic"
        >
          <Italic className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive('underline')}
          title="Underline"
        >
          <Underline className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive('strike')}
          title="Strikethrough"
        >
          <Strikethrough className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive('code')}
          title="Inline Code"
        >
          <Code className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Subscript/Superscript */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleSubscript().run()}
          isActive={editor.isActive('subscript')}
          title="Subscript"
        >
          <Subscript className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
          isActive={editor.isActive('superscript')}
          title="Superscript"
        >
          <Superscript className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Text alignment */}
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          isActive={editor.isActive({ textAlign: 'left' })}
          title="Align Left"
        >
          <AlignLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          isActive={editor.isActive({ textAlign: 'center' })}
          title="Align Center"
        >
          <AlignCenter className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          isActive={editor.isActive({ textAlign: 'right' })}
          title="Align Right"
        >
          <AlignRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('justify').run()}
          isActive={editor.isActive({ textAlign: 'justify' })}
          title="Justify"
        >
          <AlignJustify className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Lists */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive('bulletList')}
          title="Bullet List"
        >
          <List className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive('orderedList')}
          title="Numbered List"
        >
          <ListOrdered className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive('taskList')}
          title="Task List"
        >
          <CheckSquare className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Block elements */}
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive('blockquote')}
          title="Blockquote"
        >
          <TextQuote className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive('codeBlock')}
          title="Code Block"
        >
          <Code2 className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Font size and colors */}
        <FontSizePicker editor={editor} />
        <ColorPicker editor={editor} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Insert menu */}
        <InsertDropdown editor={editor} />

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Source view */}
        <ToolbarButton onClick={openSource} title="View Source (HTML)">
          <FileCode2 className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Preview: the sanitized HTML, as the public site renders it (no authored scripts) */}
        <ToolbarButton onClick={openPreview} title="Preview">
          <Eye className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6 mx-1" />

        {/* Export menu */}
        <ExportDropdown editor={editor} />
      </div>

      {isSourceOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border rounded-md shadow-xl w-[90vw] max-w-4xl h-[70vh] flex flex-col">
            <div className="p-3 border-b font-semibold">Edit HTML Source</div>
            <textarea
              className="flex-1 p-3 font-mono text-sm outline-none resize-none bg-muted/30"
              value={sourceValue}
              onChange={(e) => setSourceValue(e.target.value)}
              spellCheck={false}
            />
            <div className="p-3 border-t flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setIsSourceOpen(false)}>Cancel</Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setSourceValue(formatHTML(sourceValue))}>Format</Button>
              <Button type="button" size="sm" onClick={applySource}>Apply</Button>
            </div>
          </div>
        </div>
      )}

      {isPreviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background border rounded-md shadow-xl w-[95vw] max-w-5xl h-[80vh] flex flex-col">
            <div className="p-3 border-b flex items-center justify-between">
              <div className="font-semibold">Preview</div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    openPreview();
                  }}
                >
                  Refresh
                </Button>
                <Button type="button" size="sm" onClick={() => { for (const u of previewBlobUrlsRef.current) { try { URL.revokeObjectURL(u); } catch { /* ignore revoke errors */ } } previewBlobUrlsRef.current = []; if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); setIsPreviewOpen(false); }}>Close</Button>
              </div>
            </div>
            <div className="flex-1">
              <iframe
                title="Editor Preview"
                className="w-full h-full"
                sandbox="allow-scripts allow-same-origin allow-modals"
                src={previewUrl ?? undefined}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};




