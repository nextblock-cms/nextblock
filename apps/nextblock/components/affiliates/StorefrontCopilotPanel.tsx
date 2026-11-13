'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Check,
  CircleStop,
  KeyRound,
  LayoutTemplate,
  LoaderCircle,
  PenLine,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react';
import { Button, Input, Textarea } from '@nextblock-cms/ui';
import {
  AFFILIATES_COPILOT_COPY,
  RETAILER_COPILOT_TOOL_NAMES,
  StorefrontRenderer,
  sanitizeStorefrontBlocks,
  storefrontDocToPlainText,
  useAffiliatesCopy,
  type AffiliatesCopilotCopyKey,
  type AffiliatesCopyTranslate,
  type AffiliatesCopyValues,
  type StorefrontBlockNode,
  type StorefrontEditorApi,
  type StorefrontRenderProductGridArgs,
  type StorefrontRendererLabels,
} from '@nextblock-cms/affiliates';
import type { RetailerCopilotToolName } from '@nextblock-cms/affiliates/server';

import {
  CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY,
  CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY,
  buildCortexAiRequestHeaders,
} from '../../lib/cortex-ai/sandbox-headers';

/**
 * The partner storefront assistant (SPEC §8, W2-COPILOT): a chat panel beside the storefront
 * editor that talks to `/api/affiliates/cortex` and turns the copilot's three output-only tools
 * into suggestions the partner applies themselves:
 * - a bio (and search description) → "Apply to my profile" (`onApplyBio`);
 * - a storefront section → rendered with `StorefrontRenderer` → "Insert into my page"
 *   (`onBeforeInsert`, then `editorApi.insertBlocks`);
 * - a rewrite of the selected text → "Replace selection" (`editorApi.replaceSelection`), only for
 *   text inside one paragraph, heading or list item: a wider selection is refused with a notice,
 *   so the rewrite never merges blocks or deletes a product grid, a photo or a divider.
 * Nothing is written by the assistant itself: the editor's autosave stores whatever the partner
 * inserts. Every string comes from `AFFILIATES_COPILOT_COPY` (EN + Québec FR); server messages are
 * never shown verbatim.
 *
 * On the public sandbox (`NEXT_PUBLIC_IS_SANDBOX`), which spends no OpenRouter credits on
 * visitors, the panel also shows a field for the visitor's own key. It is saved in this browser
 * under `CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY`, the entry the CMS Cortex settings use, and
 * `buildCortexAiRequestHeaders()` attaches it to each copilot request (the route reads that header
 * only on the sandbox). The panel only ever checks whether a key is saved: it never reads the
 * value back, logs it or puts it in a URL. An "unavailable" answer while no key is saved points to
 * the field. Off the sandbox none of this renders, and storage is never touched.
 */

export interface StorefrontCopilotPanelProps {
  /** The open storefront editor (null while it loads): selection, insert and replace. */
  editorApi: StorefrontEditorApi | null;
  /** The language the assistant writes in (`fr` → Canadian French). */
  locale: 'en' | 'fr';
  /** Image origins the section previews may load (`getStorefrontImageOrigins()` on the server). */
  allowedImageOrigins: readonly string[];
  disabled?: boolean;
  /** Shown while `disabled` (already localized by the page), e.g. "Your page is in review". */
  disabledReason?: string | null;
  onApplyBio: (result: { bio: string; metaDescription: string }) => void;
  /** Awaited before a section is inserted (e.g. flush the editor's pending autosave). */
  onBeforeInsert?: () => Promise<void> | void;
}

const COPILOT_ENDPOINT = '/api/affiliates/cortex';
/** The request is aborted after this long without any stream activity (heartbeats included). */
const IDLE_TIMEOUT_MS = 90_000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SELECTION_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 12;

/** The route ignores a longer key header (`MAX_SANDBOX_KEY_LENGTH` in `app/api/affiliates/cortex/route.ts`). */
const MAX_SANDBOX_KEY_LENGTH = 512;
/** The CMS Cortex settings' key field asks for at least this many characters as well. */
const MIN_SANDBOX_KEY_LENGTH = 12;
/** Visible ASCII only: anything else is a copy mistake, and some of it could not travel in a header. */
const SANDBOX_KEY_CHARACTERS = /^[\x21-\x7e]+$/;
/**
 * Fired on this window after the panel saves or forgets the key (no payload). The `storage` event
 * only reaches the browser's other tabs, such as the CMS Cortex settings open beside the portal.
 */
const SANDBOX_KEY_CHANGED_EVENT = 'nextblock:affiliates-copilot-sandbox-key';

type CopilotNotice = { key: AffiliatesCopilotCopyKey; values?: AffiliatesCopyValues };

type CopilotCard =
  | { kind: 'bio'; id: string; bio: string; metaDescription: string; done: boolean }
  | { kind: 'section'; id: string; nodes: StorefrontBlockNode[]; skipped: boolean; done: boolean }
  | { kind: 'rewrite'; id: string; text: string; done: boolean }
  | { kind: 'failure'; id: string; key: AffiliatesCopilotCopyKey };

interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: CopilotCard[];
  notice: CopilotNotice | null;
  pending: boolean;
  activity: RetailerCopilotToolName | null;
}

type CopilotStreamEvent = { type: string } & Record<string, unknown>;

const TOOL_NAMES: ReadonlySet<string> = new Set(RETAILER_COPILOT_TOOL_NAMES);

const TOOL_FAILURE_KEYS = new Map<string, AffiliatesCopilotCopyKey>([
  ['invalid_input', 'affiliates.copilot.error_invalid_input'],
  ['empty_output', 'affiliates.copilot.error_empty_output'],
  ['empty_section', 'affiliates.copilot.error_empty_section'],
  ['section_limit', 'affiliates.copilot.error_section_limit'],
]);

const RUNNING_KEYS: Record<RetailerCopilotToolName, AffiliatesCopilotCopyKey> = {
  generate_retailer_bio: 'affiliates.copilot.running_bio',
  generate_storefront_section: 'affiliates.copilot.running_section',
  rewrite_storefront_copy: 'affiliates.copilot.running_rewrite',
};

const CARD_CLASS = 'w-full rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm';
const SCROLL_REGION_CLASS =
  'overflow-y-auto rounded-md border border-border bg-background p-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolNameOf(value: unknown): RetailerCopilotToolName | null {
  return typeof value === 'string' && TOOL_NAMES.has(value) ? (value as RetailerCopilotToolName) : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** The hosted public sandbox. Inlined at build, like `SandboxCredentialsAlert` reads it. */
function isSandboxBuild(): boolean {
  return process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
}

/**
 * Whether this browser holds a sandbox key (`buildCortexAiRequestHeaders()` sends any non-empty
 * one). Only the presence leaves this function. Storage can throw on access (blocked site data).
 */
function hasStoredSandboxKey(): boolean {
  try {
    return Boolean(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)?.trim());
  } catch {
    return false;
  }
}

function noStoredSandboxKeyOnServer(): boolean {
  return false;
}

function subscribeToSandboxKey(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    // `key` is null when another tab cleared the whole storage.
    if (event.key === null || event.key === CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(SANDBOX_KEY_CHANGED_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(SANDBOX_KEY_CHANGED_EVENT, onChange);
  };
}

function announceSandboxKeyChange() {
  window.dispatchEvent(new Event(SANDBOX_KEY_CHANGED_EVENT));
}

function isPlausibleSandboxKey(value: string): boolean {
  return (
    value.length >= MIN_SANDBOX_KEY_LENGTH && value.length <= MAX_SANDBOX_KEY_LENGTH && SANDBOX_KEY_CHARACTERS.test(value)
  );
}

/** One SSE frame (`data: {…}` lines) → event, or null for anything malformed. */
function parseStreamFrame(frame: string): CopilotStreamEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) && typeof parsed['type'] === 'string' ? (parsed as CopilotStreamEvent) : null;
  } catch {
    return null;
  }
}

/** The editor's selected text, trimmed and capped at 4000 characters; null when nothing is selected. */
function readEditorSelection(api: StorefrontEditorApi | null): string | null {
  if (!api) return null;
  try {
    const text = api.getSelectedText();
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    return trimmed === '' ? null : clip(trimmed, MAX_SELECTION_LENGTH);
  } catch {
    return null;
  }
}

/**
 * Whether the editor can replace its selection: text inside one paragraph, heading or list item.
 * A rewrite replaces nothing else (blocks are never merged, and grids, photos and dividers never
 * deleted), so neither a polish request nor a replace is attempted for anything wider.
 */
function canReplaceEditorSelection(api: StorefrontEditorApi): boolean {
  try {
    return api.canReplaceSelection() === true;
  } catch {
    return false;
  }
}

/** What the model sees of an earlier answer: its reply plus the text of what it suggested. */
function historyContent(message: CopilotMessage): string {
  if (message.role === 'user') return message.content;
  const parts = [message.content];
  for (const card of message.cards) {
    if (card.kind === 'bio') parts.push(card.bio, card.metaDescription);
    else if (card.kind === 'section') parts.push(storefrontDocToPlainText({ type: 'doc', content: card.nodes }));
    else if (card.kind === 'rewrite') parts.push(card.text);
  }
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
}

/** The last 12 non-empty turns, each at most 4000 characters (the route's limits). */
function buildHistory(messages: readonly CopilotMessage[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .map((message) => ({ role: message.role, content: clip(historyContent(message).trim(), MAX_MESSAGE_LENGTH).trim() }))
    .filter((entry) => entry.content !== '')
    .slice(-MAX_HISTORY_MESSAGES);
}

/**
 * The notice for a refused request. `sandboxKeyMissing` (the sandbox, and no key saved in this
 * browser) turns "unavailable" into a pointer to the key field: on the sandbox the route answers
 * 503 when no visitor key came with the request.
 */
function noticeForResponse(response: Response, sandboxKeyMissing = false): CopilotNotice {
  switch (response.status) {
    case 400:
    case 413:
      return { key: 'affiliates.copilot.error_invalid_request' };
    case 401:
    case 403:
      return { key: 'affiliates.copilot.error_forbidden' };
    case 429: {
      const seconds = Number(response.headers.get('retry-after'));
      if (Number.isFinite(seconds) && seconds > 0) {
        return { key: 'affiliates.copilot.error_rate_limited', values: { minutes: Math.max(1, Math.ceil(seconds / 60)) } };
      }
      return { key: 'affiliates.copilot.error_rate_limited_later' };
    }
    case 502:
    case 503:
    case 504:
      return {
        key: sandboxKeyMissing ? 'affiliates.copilot.error_unavailable_sandbox' : 'affiliates.copilot.error_unavailable',
      };
    default:
      return { key: 'affiliates.copilot.error_generic' };
  }
}

function positiveCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The message's cards plus `card`. A failure already shown in this message is not repeated: a
 * model that makes the same refused call several times (e.g. sections past the request's cap)
 * gets one notice, not a stack of identical ones.
 */
function withCard(cards: readonly CopilotCard[], card: CopilotCard): CopilotCard[] {
  if (card.kind === 'failure' && cards.some((existing) => existing.kind === 'failure' && existing.key === card.key)) {
    return [...cards];
  }
  return [...cards, card];
}

/** A tool result → a suggestion card (re-validated here; the editor sanitizes again on insert). */
function cardFromToolResult(
  toolName: RetailerCopilotToolName,
  output: unknown,
  allowedImageOrigins: readonly string[],
  id: string,
): CopilotCard {
  if (!isRecord(output)) return { kind: 'failure', id, key: 'affiliates.copilot.error_tool' };
  if (output['ok'] !== true) {
    const code = typeof output['error'] === 'string' ? output['error'] : '';
    return { kind: 'failure', id, key: TOOL_FAILURE_KEYS.get(code) ?? 'affiliates.copilot.error_tool' };
  }

  if (toolName === 'generate_retailer_bio') {
    const bio = typeof output['bio'] === 'string' ? output['bio'].trim() : '';
    const metaDescription = typeof output['meta_description'] === 'string' ? output['meta_description'].trim() : '';
    if (bio === '') return { kind: 'failure', id, key: 'affiliates.copilot.error_empty_output' };
    return { kind: 'bio', id, bio, metaDescription, done: false };
  }

  if (toolName === 'generate_storefront_section') {
    const { blocks } = sanitizeStorefrontBlocks(output['nodes'], { allowedImageOrigins });
    if (blocks.length === 0) return { kind: 'failure', id, key: 'affiliates.copilot.error_empty_section' };
    const skipped = isRecord(output['skipped'])
      ? positiveCount(output['skipped']['productIds']) || positiveCount(output['skipped']['images'])
      : false;
    return { kind: 'section', id, nodes: blocks, skipped, done: false };
  }

  const text = typeof output['text'] === 'string' ? output['text'].trim() : '';
  if (text === '') return { kind: 'failure', id, key: 'affiliates.copilot.error_empty_output' };
  return { kind: 'rewrite', id, text, done: false };
}

interface SuggestionActionProps {
  label: string;
  doneLabel: string;
  done: boolean;
  busy?: boolean;
  disabled: boolean;
  onAction: () => void;
}

function SuggestionAction({ label, doneLabel, done, busy = false, disabled, onAction }: SuggestionActionProps) {
  return (
    <Button type="button" size="sm" onClick={onAction} disabled={disabled || done || busy} aria-busy={busy || undefined}>
      {done ? <Check aria-hidden="true" className="mr-1 h-4 w-4" /> : null}
      {busy ? <LoaderCircle aria-hidden="true" className="mr-1 h-4 w-4 animate-spin" /> : null}
      {done ? doneLabel : label}
    </Button>
  );
}

export function StorefrontCopilotPanel({
  editorApi,
  locale,
  allowedImageOrigins,
  disabled = false,
  disabledReason = null,
  onApplyBio,
  onBeforeInsert,
}: StorefrontCopilotPanelProps) {
  const { t } = useAffiliatesCopy(AFFILIATES_COPILOT_COPY);
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const hintId = useId();

  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<CopilotNotice | null>(null);
  const [busyCardId, setBusyCardId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  const messagesRef = useRef<CopilotMessage[]>([]);
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const idRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const editorApiRef = useRef<StorefrontEditorApi | null>(editorApi);
  const sandbox = isSandboxBuild();
  const sandboxKeyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    editorApiRef.current = editorApi;
  }, [editorApi]);

  const focusSandboxKeyField = useCallback(() => {
    sandboxKeyInputRef.current?.focus();
  }, []);

  const nextId = useCallback((prefix: string) => {
    idRef.current += 1;
    return `${prefix}-${idRef.current}`;
  }, []);

  const commitMessages = useCallback((update: (current: CopilotMessage[]) => CopilotMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    if (mountedRef.current) setMessages(messagesRef.current);
  }, []);

  const updateMessage = useCallback(
    (id: string, update: (message: CopilotMessage) => CopilotMessage) => {
      commitMessages((current) => current.map((message) => (message.id === id ? update(message) : message)));
    },
    [commitMessages],
  );

  const markCardDone = useCallback(
    (messageId: string, cardId: string) => {
      updateMessage(messageId, (message) => ({
        ...message,
        cards: message.cards.map((card) => (card.id === cardId && card.kind !== 'failure' ? { ...card, done: true } : card)),
      }));
    },
    [updateMessage],
  );

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const field = inputRef.current;
    if (!field) return;
    field.focus();
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [focusRequest]);

  const applyStreamEvent = useCallback(
    (assistantId: string, event: CopilotStreamEvent) => {
      switch (event.type) {
        case 'tool-call': {
          const toolName = toolNameOf(event['toolName']);
          if (toolName) updateMessage(assistantId, (message) => ({ ...message, activity: toolName }));
          return;
        }
        case 'tool-result': {
          const toolName = toolNameOf(event['toolName']);
          if (!toolName) return;
          const card = cardFromToolResult(toolName, event['output'], allowedImageOrigins, nextId('card'));
          updateMessage(assistantId, (message) => ({ ...message, activity: null, cards: withCard(message.cards, card) }));
          return;
        }
        case 'tool-error': {
          const card: CopilotCard = { kind: 'failure', id: nextId('card'), key: 'affiliates.copilot.error_tool' };
          updateMessage(assistantId, (message) => ({ ...message, activity: null, cards: withCard(message.cards, card) }));
          return;
        }
        case 'text-delta': {
          const text = event['text'];
          if (typeof text !== 'string') return;
          updateMessage(assistantId, (message) => ({ ...message, content: clip(`${message.content}${text}`, MAX_MESSAGE_LENGTH * 2) }));
          return;
        }
        case 'error': {
          const key: AffiliatesCopilotCopyKey =
            event['code'] === 'timeout' ? 'affiliates.copilot.error_timeout' : 'affiliates.copilot.error_generic';
          updateMessage(assistantId, (message) => ({ ...message, notice: { key } }));
          return;
        }
        default:
          return;
      }
    },
    [allowedImageOrigins, nextId, updateMessage],
  );

  const send = useCallback(
    async (rawText: string, options: { requireSelection?: boolean } = {}) => {
      const text = clip(rawText.trim(), MAX_MESSAGE_LENGTH).trim();
      if (text === '' || streamingRef.current || disabled) return;

      const selection = readEditorSelection(editorApi);
      if (options.requireSelection && selection === null) {
        setNotice({ key: 'affiliates.copilot.polish_needs_selection' });
        return;
      }
      // A polish exists to replace the selection: no request for one that cannot be replaced.
      if (options.requireSelection && editorApi && !canReplaceEditorSelection(editorApi)) {
        setNotice({ key: 'affiliates.copilot.polish_single_block' });
        return;
      }

      const userMessage: CopilotMessage = {
        id: nextId('user'),
        role: 'user',
        content: text,
        cards: [],
        notice: null,
        pending: false,
        activity: null,
      };
      const assistantId = nextId('assistant');
      const history = buildHistory([...messagesRef.current, userMessage]);
      commitMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: 'assistant', content: '', cards: [], notice: null, pending: true, activity: null },
      ]);
      setNotice(null);
      setInput('');
      streamingRef.current = true;
      stopRequestedRef.current = false;
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let timedOut = false;
      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimerRef.current = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, IDLE_TIMEOUT_MS);
      };
      const settle = (patch: (message: CopilotMessage) => Partial<CopilotMessage> = () => ({})) => {
        updateMessage(assistantId, (message) => ({ ...message, ...patch(message), pending: false, activity: null }));
      };
      armIdleTimer();

      try {
        const response = await fetch(COPILOT_ENDPOINT, {
          method: 'POST',
          headers: buildCortexAiRequestHeaders(),
          body: JSON.stringify({ messages: history, locale, selection }),
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // Storage is read on the sandbox only, and only for whether a key is saved.
          const sandboxKeyMissing = sandbox && !hasStoredSandboxKey();
          settle(() => ({ notice: noticeForResponse(response, sandboxKeyMissing) }));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawFinish = false;
        let sawEvent = false;

        while (!sawFinish) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const event = parseStreamFrame(frame);
            if (!event) continue;
            if (event.type === 'finish') {
              sawFinish = true;
              break;
            }
            if (event.type !== 'status') sawEvent = true;
            applyStreamEvent(assistantId, event);
          }
        }

        if (sawFinish) {
          await reader.cancel().catch(() => undefined);
        } else if (buffer.trim() !== '') {
          const event = parseStreamFrame(buffer);
          if (event && event.type !== 'finish' && event.type !== 'status') {
            sawEvent = true;
            applyStreamEvent(assistantId, event);
          }
        }

        settle((message) =>
          !sawFinish && !sawEvent && message.notice === null ? { notice: { key: 'affiliates.copilot.error_generic' } } : {},
        );
      } catch {
        if (controller.signal.aborted && timedOut) {
          settle(() => ({ notice: { key: 'affiliates.copilot.error_timeout' } }));
        } else if (controller.signal.aborted) {
          settle((message) =>
            stopRequestedRef.current && message.content === '' && message.cards.length === 0
              ? { notice: { key: 'affiliates.copilot.stopped' } }
              : {},
          );
        } else {
          settle(() => ({ notice: { key: 'affiliates.copilot.error_network' } }));
        }
      } finally {
        clearIdleTimer();
        if (abortRef.current === controller) abortRef.current = null;
        streamingRef.current = false;
        if (mountedRef.current) setStreaming(false);
      }
    },
    [applyStreamEvent, clearIdleTimer, commitMessages, disabled, editorApi, locale, nextId, sandbox, updateMessage],
  );

  const stop = useCallback(() => {
    stopRequestedRef.current = true;
    abortRef.current?.abort();
  }, []);

  const resetConversation = useCallback(() => {
    if (streamingRef.current) return;
    commitMessages(() => []);
    setNotice(null);
  }, [commitMessages]);

  const prefillComposer = useCallback(
    (key: 'affiliates.copilot.quick_bio_prompt' | 'affiliates.copilot.quick_section_prompt') => {
      if (disabled || streamingRef.current) return;
      setInput(`${t(key)} `);
      setNotice(null);
      setFocusRequest((count) => count + 1);
    },
    [disabled, t],
  );

  const applyBio = useCallback(
    (messageId: string, card: Extract<CopilotCard, { kind: 'bio' }>) => {
      if (disabled) return;
      try {
        onApplyBio({ bio: card.bio, metaDescription: card.metaDescription });
      } catch {
        setNotice({ key: 'affiliates.copilot.error_generic' });
        return;
      }
      markCardDone(messageId, card.id);
      setNotice({ key: 'affiliates.copilot.bio_applied' });
    },
    [disabled, markCardDone, onApplyBio],
  );

  const insertSection = useCallback(
    async (messageId: string, card: Extract<CopilotCard, { kind: 'section' }>) => {
      if (disabled || busyCardId !== null) return;
      if (!editorApi) {
        setNotice({ key: 'affiliates.copilot.editor_not_ready' });
        return;
      }
      setBusyCardId(card.id);
      try {
        await onBeforeInsert?.();
        // The editor the page holds now (it may have been replaced while the page saved).
        const api = editorApiRef.current;
        if (!api) {
          setNotice({ key: 'affiliates.copilot.editor_not_ready' });
          return;
        }
        api.insertBlocks(card.nodes);
        markCardDone(messageId, card.id);
        setNotice({ key: 'affiliates.copilot.section_inserted' });
      } catch {
        setNotice({ key: 'affiliates.copilot.insert_failed' });
      } finally {
        if (mountedRef.current) setBusyCardId(null);
      }
    },
    [busyCardId, disabled, editorApi, markCardDone, onBeforeInsert],
  );

  const replaceSelection = useCallback(
    (messageId: string, card: Extract<CopilotCard, { kind: 'rewrite' }>) => {
      if (disabled) return;
      if (!editorApi) {
        setNotice({ key: 'affiliates.copilot.editor_not_ready' });
        return;
      }
      if (readEditorSelection(editorApi) === null) {
        setNotice({ key: 'affiliates.copilot.replace_needs_selection' });
        return;
      }
      if (!canReplaceEditorSelection(editorApi)) {
        setNotice({ key: 'affiliates.copilot.replace_single_block' });
        return;
      }
      try {
        // The editor reports whether it replaced anything; the card stays usable when it did not.
        if (editorApi.replaceSelection(card.text) !== true) {
          setNotice({ key: 'affiliates.copilot.error_generic' });
          return;
        }
        markCardDone(messageId, card.id);
        setNotice({ key: 'affiliates.copilot.selection_replaced' });
      } catch {
        setNotice({ key: 'affiliates.copilot.error_generic' });
      }
    },
    [disabled, editorApi, markCardDone],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input);
    }
  };

  const rendererLabels = useMemo<Partial<StorefrontRendererLabels>>(
    () => ({ photoCredit: (photographer, provider) => t('affiliates.copilot.photo_credit', { photographer, provider }) }),
    [t],
  );

  const renderProductGrid = useCallback(
    ({ productIds, title }: StorefrontRenderProductGridArgs): ReactNode => (
      <div className="rounded-md border border-dashed border-border p-3 text-sm">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        <p className="text-muted-foreground">
          {productIds.length === 1
            ? t('affiliates.copilot.section_products_one')
            : t('affiliates.copilot.section_products_other', { count: productIds.length })}
        </p>
      </div>
    ),
    [t],
  );

  const composerDisabled = disabled || streaming;
  const editorActionsDisabled = disabled || editorApi === null;

  return (
    <section
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Sparkles aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
            {t('affiliates.copilot.panel_title')}
          </h2>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {t('affiliates.copilot.panel_description')}
          </p>
        </div>
        {messages.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={resetConversation} disabled={streaming}>
            <RotateCcw aria-hidden="true" className="mr-1 h-4 w-4" />
            {t('affiliates.copilot.new_conversation')}
          </Button>
        ) : null}
      </div>

      {disabled ? (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
          {disabledReason?.trim() || t('affiliates.copilot.disabled_default')}
        </p>
      ) : null}

      {sandbox ? <SandboxKeyField t={t} inputRef={sandboxKeyInputRef} /> : null}

      <div role="group" aria-label={t('affiliates.copilot.quick_actions_label')} className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={composerDisabled}
          onClick={() => prefillComposer('affiliates.copilot.quick_bio_prompt')}
        >
          <PenLine aria-hidden="true" className="mr-1 h-4 w-4" />
          {t('affiliates.copilot.quick_bio')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={composerDisabled}
          onClick={() => prefillComposer('affiliates.copilot.quick_section_prompt')}
        >
          <LayoutTemplate aria-hidden="true" className="mr-1 h-4 w-4" />
          {t('affiliates.copilot.quick_section')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={composerDisabled}
          onClick={() => void send(t('affiliates.copilot.quick_polish_prompt'), { requireSelection: true })}
        >
          <WandSparkles aria-hidden="true" className="mr-1 h-4 w-4" />
          {t('affiliates.copilot.quick_polish')}
        </Button>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-busy={streaming}
        aria-label={t('affiliates.copilot.messages_label')}
        tabIndex={0}
        className={`flex max-h-[28rem] min-h-40 flex-col gap-4 ${SCROLL_REGION_CLASS}`}
      >
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('affiliates.copilot.empty_state')}</p>
        ) : (
          messages.map((message) => (
            <CopilotMessageView
              key={message.id}
              message={message}
              t={t}
              allowedImageOrigins={allowedImageOrigins}
              rendererLabels={rendererLabels}
              renderProductGrid={renderProductGrid}
              disabled={disabled}
              editorActionsDisabled={editorActionsDisabled}
              editorReady={editorApi !== null}
              busyCardId={busyCardId}
              onApplyBio={applyBio}
              onInsertSection={insertSection}
              onReplaceSelection={replaceSelection}
              onAddSandboxKey={sandbox ? focusSandboxKeyField : undefined}
            />
          ))
        )}
      </div>

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-foreground">
        {notice ? t(notice.key, notice.values) : null}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t('affiliates.copilot.input_label')}
        </label>
        <Textarea
          id={inputId}
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={3}
          placeholder={t('affiliates.copilot.input_placeholder')}
          aria-describedby={hintId}
          // Stays enabled while a reply streams (focus is kept; sending waits for the reply).
          disabled={disabled}
          className="resize-y"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('affiliates.copilot.input_hint')}
          </p>
          <div className="flex items-center gap-2">
            {streaming ? (
              <Button type="button" variant="outline" size="sm" onClick={stop}>
                <CircleStop aria-hidden="true" className="mr-1 h-4 w-4" />
                {t('affiliates.copilot.stop')}
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={composerDisabled || input.trim() === ''}>
              <Send aria-hidden="true" className="mr-1 h-4 w-4" />
              {t('affiliates.copilot.send')}
            </Button>
          </div>
        </div>
      </form>

      <p className="text-xs text-muted-foreground">{t('affiliates.copilot.disclaimer')}</p>
    </section>
  );
}

/** What the last save or removal did, until the visitor types in the field again. */
type SandboxKeyNotice =
  | 'affiliates.copilot.sandbox_key_saved'
  | 'affiliates.copilot.sandbox_key_forgotten'
  | 'affiliates.copilot.sandbox_key_invalid'
  | 'affiliates.copilot.sandbox_key_storage_failed';

/** The visible line under the key field: a refused save says why, else whether a key is saved. */
function sandboxKeyStatusKey(stored: boolean, notice: SandboxKeyNotice | null): AffiliatesCopilotCopyKey | null {
  if (notice === 'affiliates.copilot.sandbox_key_invalid' || notice === 'affiliates.copilot.sandbox_key_storage_failed') {
    return notice;
  }
  // "Saved" and "removed" follow the storage, which another tab can change after either.
  if (stored) return 'affiliates.copilot.sandbox_key_saved';
  return notice === 'affiliates.copilot.sandbox_key_forgotten' ? notice : null;
}

interface SandboxKeyFieldProps {
  t: AffiliatesCopyTranslate;
  /** The password input, so an "unavailable" notice can move focus to it. */
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The sandbox's own-key field (rendered only there). The value goes from the input straight to
 * `localStorage` and is never held in React state; the input has no `name`, so a submit before
 * hydration (a GET to this page) cannot carry it into a URL. "Remove key" removes it, and the model
 * picked for it in the CMS settings, as that screen's "Clear" does.
 */
function SandboxKeyField({ t, inputRef }: SandboxKeyFieldProps) {
  const fieldId = useId();
  const inputId = `${fieldId}-input`;
  const hintId = `${fieldId}-hint`;
  const statusId = `${fieldId}-status`;
  const stored = useSyncExternalStore(subscribeToSandboxKey, hasStoredSandboxKey, noStoredSandboxKeyOnServer);
  const [hasDraft, setHasDraft] = useState(false);
  const [notice, setNotice] = useState<SandboxKeyNotice | null>(null);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = inputRef.current;
    const key = field ? field.value.trim() : '';
    if (!field || key === '') return;
    if (!isPlausibleSandboxKey(key)) {
      setNotice('affiliates.copilot.sandbox_key_invalid');
      return;
    }
    try {
      window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, key);
    } catch {
      setNotice('affiliates.copilot.sandbox_key_storage_failed');
      return;
    }
    field.value = '';
    setHasDraft(false);
    setNotice('affiliates.copilot.sandbox_key_saved');
    announceSandboxKeyChange();
  };

  const forget = () => {
    try {
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY);
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY);
    } catch {
      setNotice('affiliates.copilot.sandbox_key_storage_failed');
      return;
    }
    const field = inputRef.current;
    if (field) {
      field.value = '';
      // This button is about to disappear: keep focus in the field rather than on the page body.
      field.focus();
    }
    setHasDraft(false);
    setNotice('affiliates.copilot.sandbox_key_forgotten');
    announceSandboxKeyChange();
  };

  const statusKey = sandboxKeyStatusKey(stored, notice);
  const failed = notice === 'affiliates.copilot.sandbox_key_invalid' || notice === 'affiliates.copilot.sandbox_key_storage_failed';
  // Only a result that is still true is repeated (another tab can add or remove the key since).
  const announcement = notice !== null && statusKey === notice ? notice : null;

  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-background p-3">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {t('affiliates.copilot.sandbox_key_label')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_SANDBOX_KEY_LENGTH}
          aria-describedby={`${hintId} ${statusId}`}
          aria-invalid={notice === 'affiliates.copilot.sandbox_key_invalid' || undefined}
          onChange={(event) => {
            setHasDraft(event.target.value.trim() !== '');
            setNotice(null);
          }}
          className="min-w-0 flex-1 basis-48"
        />
        <Button type="submit" size="sm" disabled={!hasDraft}>
          <KeyRound aria-hidden="true" className="mr-1 h-4 w-4" />
          {t('affiliates.copilot.sandbox_key_save')}
        </Button>
        {stored ? (
          <Button type="button" variant="ghost" size="sm" onClick={forget}>
            <Trash2 aria-hidden="true" className="mr-1 h-4 w-4" />
            {t('affiliates.copilot.sandbox_key_forget')}
          </Button>
        ) : null}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('affiliates.copilot.sandbox_key_hint')}
      </p>
      {/* No live region: it fills after hydration whenever a key is saved, and would speak on every load. */}
      <p
        id={statusId}
        className={failed ? 'min-h-4 text-xs font-medium text-red-800 dark:text-red-300' : 'min-h-4 text-xs text-muted-foreground'}
      >
        {statusKey ? t(statusKey) : null}
      </p>
      {/* What the last save or removal did (a refusal included), announced once. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement ? t(announcement) : null}
      </p>
    </form>
  );
}

interface CopilotMessageViewProps {
  message: CopilotMessage;
  t: AffiliatesCopyTranslate;
  allowedImageOrigins: readonly string[];
  rendererLabels: Partial<StorefrontRendererLabels>;
  renderProductGrid: (args: StorefrontRenderProductGridArgs) => ReactNode;
  disabled: boolean;
  editorActionsDisabled: boolean;
  editorReady: boolean;
  busyCardId: string | null;
  onApplyBio: (messageId: string, card: Extract<CopilotCard, { kind: 'bio' }>) => void;
  onInsertSection: (messageId: string, card: Extract<CopilotCard, { kind: 'section' }>) => Promise<void>;
  onReplaceSelection: (messageId: string, card: Extract<CopilotCard, { kind: 'rewrite' }>) => void;
  /** Sandbox only: focuses the own-key field from the "add your key" notice. */
  onAddSandboxKey?: () => void;
}

function CopilotMessageView({
  message,
  t,
  allowedImageOrigins,
  rendererLabels,
  renderProductGrid,
  disabled,
  editorActionsDisabled,
  editorReady,
  busyCardId,
  onApplyBio,
  onInsertSection,
  onReplaceSelection,
  onAddSandboxKey,
}: CopilotMessageViewProps) {
  const isUser = message.role === 'user';

  return (
    <div className={isUser ? 'flex flex-col items-end gap-1' : 'flex flex-col items-start gap-2'}>
      <p className="text-xs font-medium text-muted-foreground">
        {isUser ? t('affiliates.copilot.speaker_you') : t('affiliates.copilot.speaker_assistant')}
      </p>
      {message.content ? (
        <p
          className={
            isUser
              ? 'max-w-[85%] whitespace-pre-line break-words rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
              : 'max-w-full whitespace-pre-line break-words rounded-lg bg-muted px-3 py-2 text-sm text-foreground'
          }
        >
          {message.content}
        </p>
      ) : null}

      {message.cards.map((card) => {
        if (card.kind === 'failure') {
          return (
            <p key={card.id} className={`flex items-start gap-2 text-sm ${CARD_CLASS}`}>
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {t(card.key)}
            </p>
          );
        }

        if (card.kind === 'bio') {
          return (
            <div key={card.id} className={CARD_CLASS}>
              <p className="text-sm font-semibold">{t('affiliates.copilot.bio_title')}</p>
              <p className="mt-2 whitespace-pre-line break-words text-sm">{card.bio}</p>
              {card.metaDescription ? (
                <>
                  <p className="mt-3 text-xs font-medium text-muted-foreground">{t('affiliates.copilot.bio_meta_label')}</p>
                  <p className="mt-1 break-words text-sm">{card.metaDescription}</p>
                </>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <SuggestionAction
                  label={t('affiliates.copilot.apply_bio')}
                  doneLabel={t('affiliates.copilot.bio_applied')}
                  done={card.done}
                  disabled={disabled}
                  onAction={() => onApplyBio(message.id, card)}
                />
              </div>
            </div>
          );
        }

        if (card.kind === 'section') {
          return (
            <div key={card.id} className={CARD_CLASS}>
              <p className="text-sm font-semibold">{t('affiliates.copilot.section_title')}</p>
              <div
                role="region"
                aria-label={t('affiliates.copilot.section_preview_label')}
                tabIndex={0}
                className={`mt-2 max-h-80 ${SCROLL_REGION_CLASS}`}
              >
                <StorefrontRenderer
                  doc={{ type: 'doc', content: card.nodes }}
                  allowedImageOrigins={allowedImageOrigins}
                  labels={rendererLabels}
                  renderProductGrid={renderProductGrid}
                />
              </div>
              {card.skipped ? <p className="mt-2 text-xs text-muted-foreground">{t('affiliates.copilot.section_skipped')}</p> : null}
              {!editorReady && !card.done ? (
                <p className="mt-2 text-xs text-muted-foreground">{t('affiliates.copilot.editor_not_ready')}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <SuggestionAction
                  label={t('affiliates.copilot.insert_section')}
                  doneLabel={t('affiliates.copilot.section_inserted')}
                  done={card.done}
                  busy={busyCardId === card.id}
                  disabled={editorActionsDisabled || (busyCardId !== null && busyCardId !== card.id)}
                  onAction={() => void onInsertSection(message.id, card)}
                />
              </div>
            </div>
          );
        }

        return (
          <div key={card.id} className={CARD_CLASS}>
            <p className="text-sm font-semibold">{t('affiliates.copilot.rewrite_title')}</p>
            <p className="mt-2 whitespace-pre-line break-words text-sm">{card.text}</p>
            {!editorReady && !card.done ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('affiliates.copilot.editor_not_ready')}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SuggestionAction
                label={t('affiliates.copilot.replace_selection')}
                doneLabel={t('affiliates.copilot.selection_replaced')}
                done={card.done}
                disabled={editorActionsDisabled}
                onAction={() => onReplaceSelection(message.id, card)}
              />
            </div>
          </div>
        );
      })}

      {message.pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
          {t(message.activity ? RUNNING_KEYS[message.activity] : 'affiliates.copilot.working')}
        </p>
      ) : null}

      {message.notice ? (
        <p className="flex items-start gap-2 text-sm text-foreground">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          {t(message.notice.key, message.notice.values)}
        </p>
      ) : null}

      {message.notice?.key === 'affiliates.copilot.error_unavailable_sandbox' && onAddSandboxKey ? (
        <Button type="button" variant="outline" size="sm" onClick={onAddSandboxKey}>
          <KeyRound aria-hidden="true" className="mr-1 h-4 w-4" />
          {t('affiliates.copilot.sandbox_key_go_to_field')}
        </Button>
      ) : null}
    </div>
  );
}
