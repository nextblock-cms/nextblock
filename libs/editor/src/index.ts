// Main editor components
export { Editor } from './lib/editor';
export { Editor as default } from './lib/editor';
export { NotionEditor } from './lib/NotionEditor';

// Menu components
export { EditorBubbleMenu } from './lib/components/menus/BubbleMenu';
export { EditorFloatingMenu } from './lib/components/menus/FloatingMenu';
export { EnhancedFloatingMenu } from './lib/components/menus/EnhancedFloatingMenu';
export { EditorToolbar } from './lib/components/menus/Toolbar';
export { SlashCommandList } from './lib/components/menus/SlashCommandList';

// UI components
export { Toolbar, ToolbarGroup, ToolbarButton, ToolbarSeparator } from './lib/components/ui/Toolbar';
export { UndoRedoButtons } from './lib/components/ui/UndoRedoButtons';
export { DragHandle } from './lib/components/DragHandle';

// Mobile components
export { MobileToolbar } from './lib/components/mobile/MobileToolbar';

// Extensions
export { editorExtensions } from './lib/kit';
export { SlashCommand } from './lib/extensions/slash-command';
export { TrailingNode } from './lib/extensions/TrailingNode';
export { default as AlertWidget } from './lib/extensions/AlertWidget';
export { default as CtaWidgetNode } from './lib/extensions/CtaWidgetNode';
export { DraggableNodes } from './lib/extensions/DraggableNodes';
export { LowContrastTextHint, lowContrastTextHintKey } from './lib/extensions/LowContrastTextHint';

// Advanced Extensions
export { AdvancedPlaceholder } from './lib/extensions/AdvancedPlaceholder';
export { EnhancedFocus } from './lib/extensions/EnhancedFocus';
export { KeyboardShortcuts } from './lib/extensions/KeyboardShortcuts';

// Hooks
export { useEditorHistory, canExecuteHistoryAction, executeHistoryAction, getHistoryShortcut } from './lib/hooks/useEditorHistory';

// Test Components
export { FeatureValidationTest } from './lib/components/test/FeatureValidationTest';
export { UndoRedoTest } from './lib/components/test/UndoRedoTest';
export { NotionEditorEnhancedTest } from './lib/components/test/NotionEditorEnhancedTest';

// Types
export type { CommandItemProps } from './lib/extensions/slash-command';
export type { CommandListRef } from './lib/components/menus/SlashCommandList';
export type { EditorHistoryState, EditorHistoryActions } from './lib/hooks/useEditorHistory';
export type { NotionEditorProps } from './lib/NotionEditor';
export type { LowContrastTextHintOptions } from './lib/extensions/LowContrastTextHint';

// Note: CSS imports should be handled by the consuming application
