// @vitest-environment jsdom
import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY,
  CORTEX_SANDBOX_SIGN_OUT_EVENT,
  clearSandboxCortexKey,
} from '../../../lib/cortex-ai/sandbox-headers';

/**
 * Sandbox sign-out while a Cortex reply streams (2026-11-03). clearSandboxCortexKey() removes the
 * chat history, but signOutAction's redirect is a soft navigation that lands after the server round
 * trip; until then the mounted chat kept streaming and its save effect wrote every thread back, for
 * the next person on that browser to read. Sign-out now tells the chat to stop first
 * (CORTEX_SANDBOX_SIGN_OUT_EVENT): it aborts the request and saves nothing more. Off the sandbox
 * ('', 'false', 'TRUE', '1') sign-out dispatches nothing and the chat behaves as before.
 */

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/cms/dashboard',
  useRouter: () => router,
}));
vi.mock('@nextblock-cms/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode; size?: string; variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock('@nextblock-cms/ui/textarea', () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
vi.mock('@nextblock-cms/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter((value) => typeof value === 'string' && value).join(' '),
}));

import { CortexGlobalAgentChat } from './CortexGlobalAgentChat';

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;

type FakeStream = {
  /** Sends one server-sent event; false once the request was aborted (nothing more arrives). */
  push: (event: Record<string, unknown>) => boolean;
  signal: AbortSignal | undefined;
};

/**
 * `/api/ai/global-agent` as a stream the test feeds event by event. With `honourAbort` an abort
 * errors the body the way a browser does; without it the events keep arriving (chunks already in
 * the pipe when the request was aborted).
 */
function streamingFetch({ honourAbort }: { honourAbort: boolean }) {
  const streams: FakeStream[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const signal = init?.signal ?? undefined;
    if (honourAbort) {
      signal?.addEventListener('abort', () => {
        open = false;
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }
    streams.push({
      push: (event) => {
        if (!open) return false;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        return true;
      },
      signal,
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
  });
  return { fetchMock, streams };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const originalScrollTo = Element.prototype.scrollTo;

/** Lets the stream reader, React's state updates and the effects after them run. */
async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountChat() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<CortexGlobalAgentChat hasModelKey />);
  });
}

async function unmountChat() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

async function sendPrompt(text: string) {
  const textarea = container?.querySelector('textarea');
  expect(textarea).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(textarea, text);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    await settle();
  });
}

async function pushEvents(stream: FakeStream, events: Array<Record<string, unknown>>) {
  await act(async () => {
    for (const event of events) stream.push(event);
    await settle();
  });
}

async function signOut() {
  await act(async () => {
    clearSandboxCortexKey();
    await settle();
  });
}

function storedThreads() {
  return window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no Element#scrollTo; the chat scrolls its message list after every update.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  router.refresh.mockClear();
  router.replace.mockClear();
});

afterEach(async () => {
  await unmountChat();
  Element.prototype.scrollTo = originalScrollTo;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('CortexGlobalAgentChat: sandbox sign-out during a streamed reply', () => {
  it('aborts the request and leaves no chat in storage', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { fetchMock, streams } = streamingFetch({ honourAbort: true });
    vi.stubGlobal('fetch', fetchMock);
    await mountChat();

    await sendPrompt('Build me a landing page');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stream] = streams;
    await pushEvents(stream, [{ text: 'Working on ', type: 'text-delta' }]);
    // The reply is saved as it streams.
    expect(storedThreads()).toContain('Working on ');

    await signOut();

    expect(stream.signal?.aborted).toBe(true);
    expect(storedThreads()).toBeNull();
    // The aborted request delivers nothing more, and nothing is saved again.
    expect(stream.push({ text: 'the hero section', type: 'text-delta' })).toBe(false);
    await act(async () => {
      await settle();
    });
    expect(storedThreads()).toBeNull();
  });

  it('saves nothing after sign-out even while the reply keeps arriving', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const { fetchMock, streams } = streamingFetch({ honourAbort: false });
    vi.stubGlobal('fetch', fetchMock);
    await mountChat();

    await sendPrompt('Build me a landing page');
    const [stream] = streams;
    await pushEvents(stream, [{ text: 'Working on ', type: 'text-delta' }]);
    expect(storedThreads()).toContain('Working on ');

    await signOut();
    expect(storedThreads()).toBeNull();

    await pushEvents(stream, [{ text: 'the hero section', type: 'text-delta' }, { type: 'finish' }]);

    // The reply did reach the open chat (so this is the save guard, not the abort), yet the
    // history stays out of storage.
    expect(container?.textContent).toContain('Working on the hero section');
    expect(storedThreads()).toBeNull();
  });

  it('stops only the chat that was open: one mounted afterwards saves again', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    await mountChat();
    expect(storedThreads()).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event(CORTEX_SANDBOX_SIGN_OUT_EVENT));
    });
    window.localStorage.clear();
    await unmountChat();

    await mountChat();
    expect(storedThreads()).toContain('New chat');
  });
});

describe('CortexGlobalAgentChat: sign-out off the sandbox', () => {
  it.each(OFF_SANDBOX)('NEXT_PUBLIC_IS_SANDBOX=%j: the reply keeps streaming and is saved, as before', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const { fetchMock, streams } = streamingFetch({ honourAbort: true });
    vi.stubGlobal('fetch', fetchMock);
    await mountChat();

    await sendPrompt('Build me a landing page');
    const [stream] = streams;
    await pushEvents(stream, [{ text: 'Working on ', type: 'text-delta' }]);

    await signOut();
    expect(stream.signal?.aborted).toBe(false);

    await pushEvents(stream, [{ text: 'the hero section', type: 'text-delta' }, { type: 'finish' }]);
    expect(storedThreads()).toContain('Working on the hero section');
  });
});
