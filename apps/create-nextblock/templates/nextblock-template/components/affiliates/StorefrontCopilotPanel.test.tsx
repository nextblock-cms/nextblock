// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * The partner storefront assistant panel: it posts to /api/affiliates/cortex with the sandbox
 * headers, reads the SSE stream, and turns the three tool results into suggestions the partner
 * applies (bio), inserts (section) or uses to replace the editor selection (rewrite). On the
 * public sandbox it also keeps the visitor's own OpenRouter key in this browser.
 */

const mocks = vi.hoisted(() => {
  const cannedHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-sandbox-openrouter-key': 'sk-visitor',
  });
  return { cannedHeaders, headers: vi.fn(cannedHeaders) };
});

// The real storage keys; the header builder is canned unless a sandbox test puts the real one back.
vi.mock('../../lib/cortex-ai/sandbox-headers', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../lib/cortex-ai/sandbox-headers')),
  buildCortexAiRequestHeaders: mocks.headers,
}));

// Only the lib areas the panel uses (no other area's copy file), through vi.importActual: an
// import() of the lib would make Nx treat it as lazy-loaded and fail enforce-module-boundaries.
vi.mock('@nextblock-cms/affiliates', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/core/constants')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/storefront/index')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/i18n/copy/copilot')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/i18n/affiliates-copy-provider')),
  ...(await vi.importActual<Record<string, unknown>>('../../../../libs/affiliates/src/lib/i18n/use-affiliates-copy')),
}));

import { AFFILIATES_COPILOT_COPY, AffiliatesCopyProvider } from '@nextblock-cms/affiliates';
import type { StorefrontBlockNode, StorefrontEditorApi } from '@nextblock-cms/affiliates';

import {
  CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY,
  CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY,
} from '../../lib/cortex-ai/sandbox-headers';
import { StorefrontCopilotPanel, type StorefrontCopilotPanelProps } from './StorefrontCopilotPanel';

type CopyKey = keyof typeof AFFILIATES_COPILOT_COPY;
const en = (key: CopyKey) => AFFILIATES_COPILOT_COPY[key].en;
const fr = (key: CopyKey) => AFFILIATES_COPILOT_COPY[key].fr;

const ORIGINS = ['https://images.unsplash.com'];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type EditorApiMock = StorefrontEditorApi & {
  insertBlocks: Mock;
  getSelectedText: Mock;
  canReplaceSelection: Mock;
  replaceSelection: Mock;
};

function editorApiMock(selection = ''): EditorApiMock {
  return {
    insertBlocks: vi.fn(),
    getSelectedText: vi.fn(() => selection),
    canReplaceSelection: vi.fn(() => true),
    replaceSelection: vi.fn(() => true),
    getDoc: vi.fn(() => ({ type: 'doc' as const, content: [] })),
    focus: vi.fn(),
    setEditable: vi.fn(),
  };
}

function sse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function streamResponse(events: object[]): Response {
  return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let fetchMock: Mock;
let mounted: Array<{ root: Root; container: HTMLElement }> = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Off the sandbox unless a test says otherwise, whatever the shell running the tests exports.
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.headers.mockImplementation(mocks.cannedHeaders);
});

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function settle(ms = 10) {
  await act(async () => {
    await sleep(ms);
  });
}

async function waitFor<T>(read: () => T | null | undefined | false, label: string, timeout = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await settle(10);
  }
}

async function renderPanel(props: Partial<StorefrontCopilotPanelProps> = {}, locale = 'en') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const fullProps: StorefrontCopilotPanelProps = {
    editorApi: null,
    locale: locale === 'fr' ? 'fr' : 'en',
    allowedImageOrigins: ORIGINS,
    onApplyBio: vi.fn(),
    ...props,
  };
  const draw = (next: StorefrontCopilotPanelProps) =>
    act(async () => {
      root.render(
        <AffiliatesCopyProvider locale={locale}>
          <StorefrontCopilotPanel {...next} />
        </AffiliatesCopyProvider>,
      );
    });
  await draw(fullProps);
  mounted.push({ root, container });
  return {
    container,
    props: fullProps,
    rerender: (changes: Partial<StorefrontCopilotPanelProps>) => draw({ ...fullProps, ...changes }),
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
}

function requireButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = button(container, label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const field = container.querySelector('textarea');
  if (!field) throw new Error('no textarea');
  return field;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(field: HTMLTextAreaElement, init: KeyboardEventInit) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

function status(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? '';
}

function requestBody(call = 0): { messages: Array<{ role: string; content: string }>; locale: string; selection: string | null } {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

const SECTION_NODES: StorefrontBlockNode[] = [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'My candle corner' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'I light these every evening.' }] },
  {
    type: 'image',
    attrs: {
      src: 'https://images.unsplash.com/photo-1',
      alt: 'Candles on a table',
      title: null,
      width: 1080,
      height: 720,
      credit: {
        provider: 'unsplash',
        photographer: 'Jane Doe',
        photographerUrl: 'https://unsplash.com/@janedoe',
        sourceUrl: 'https://unsplash.com/photos/abc',
        downloadLocation: 'https://api.unsplash.com/photos/abc/download',
        utmSource: 'shop',
      },
    },
  },
  { type: 'affiliateProductGrid', attrs: { productIds: [uuid(1), uuid(2)], title: 'My picks', columns: 2 } },
];

describe('copilot copy keys', () => {
  it('are all defined, and every key of the dictionary is used by the panel or the route', () => {
    // `t()` accepts any string and answers an unknown key with the key itself, so a typo would ship.
    const sources = ['./StorefrontCopilotPanel.tsx', '../../app/api/affiliates/cortex/route.ts'].map((file) =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'),
    );
    const used = new Set(sources.flatMap((source) => source.match(/affiliates\.copilot\.[a-z0-9_]+/g) ?? []));
    const defined = new Set(Object.keys(AFFILIATES_COPILOT_COPY));

    expect([...used].filter((key) => !defined.has(key))).toEqual([]);
    expect([...defined].filter((key) => !used.has(key))).toEqual([]);
  });
});

describe('StorefrontCopilotPanel', () => {
  it('renders a labelled, localized panel with quick actions and a labelled composer', async () => {
    const { container } = await renderPanel();

    expect(container.querySelector('h2')?.textContent).toBe(en('affiliates.copilot.panel_title'));
    const field = textarea(container);
    expect(container.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(en('affiliates.copilot.input_label'));
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    expect(field.maxLength).toBe(4000);
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe(en('affiliates.copilot.quick_actions_label'));
    for (const key of ['affiliates.copilot.quick_bio', 'affiliates.copilot.quick_section', 'affiliates.copilot.quick_polish'] as const) {
      expect(button(container, en(key)), key).toBeDefined();
    }
    const log = container.querySelector('[role="log"]');
    expect(log?.getAttribute('aria-live')).toBe('polite');
    expect(log?.getAttribute('aria-label')).toBe(en('affiliates.copilot.messages_label'));
    expect(container.querySelectorAll('h1')).toHaveLength(0);
  });

  it('speaks Québec French under a French provider', async () => {
    const { container } = await renderPanel({}, 'fr');

    expect(container.querySelector('h2')?.textContent).toBe(fr('affiliates.copilot.panel_title'));
    expect(button(container, fr('affiliates.copilot.send'))).toBeDefined();
    expect(container.textContent).not.toContain(en('affiliates.copilot.panel_description'));
  });

  it('shows the reason and blocks the composer while disabled', async () => {
    const { container } = await renderPanel({ disabled: true, disabledReason: 'Your page is in review.' });

    expect(container.textContent).toContain('Your page is in review.');
    expect(textarea(container).disabled).toBe(true);
    expect(requireButton(container, en('affiliates.copilot.quick_bio')).disabled).toBe(true);
    expect(requireButton(container, en('affiliates.copilot.quick_polish')).disabled).toBe(true);
  });

  it('falls back to a localized reason when none is given', async () => {
    const { container } = await renderPanel({ disabled: true });

    expect(container.textContent).toContain(en('affiliates.copilot.disabled_default'));
  });

  it('sends the conversation with the sandbox headers and applies a suggested bio', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        { type: 'status' },
        { type: 'tool-call', toolName: 'generate_retailer_bio' },
        {
          type: 'tool-result',
          toolName: 'generate_retailer_bio',
          output: { ok: true, bio: 'I pour soy candles in Montréal.', meta_description: 'Hand-poured candles picked by Jane.' },
        },
        { type: 'text-delta', text: 'Here is a bio you can apply.' },
        { type: 'finish' },
      ]),
    );
    const onApplyBio = vi.fn();
    const { container } = await renderPanel({ onApplyBio });

    await type(textarea(container), 'Write my bio: candles, Montréal.');
    await click(requireButton(container, en('affiliates.copilot.send')));
    const apply = await waitFor(() => button(container, en('affiliates.copilot.apply_bio')), 'apply button');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/affiliates/cortex');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-sandbox-openrouter-key': 'sk-visitor' });
    expect(requestBody()).toEqual({
      messages: [{ role: 'user', content: 'Write my bio: candles, Montréal.' }],
      locale: 'en',
      selection: null,
    });
    expect(container.textContent).toContain('I pour soy candles in Montréal.');
    expect(container.textContent).toContain('Hand-poured candles picked by Jane.');
    expect(container.textContent).toContain('Here is a bio you can apply.');

    await click(apply);

    expect(onApplyBio).toHaveBeenCalledWith({
      bio: 'I pour soy candles in Montréal.',
      metaDescription: 'Hand-poured candles picked by Jane.',
    });
    expect(requireButton(container, en('affiliates.copilot.bio_applied')).disabled).toBe(true);
    expect(status(container)).toBe(en('affiliates.copilot.bio_applied'));
  });

  it('previews a section and inserts it after onBeforeInsert resolves', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'generate_storefront_section',
          output: {
            ok: true,
            title: 'My candle corner',
            nodes: SECTION_NODES,
            productIds: [uuid(1), uuid(2)],
            imageCount: 1,
            skipped: { productIds: 1, images: 0, blocks: 0 },
          },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock();
    let releaseSave: () => void = () => undefined;
    const onBeforeInsert = vi.fn(() => new Promise<void>((resolve) => (releaseSave = resolve)));
    const { container } = await renderPanel({ editorApi, onBeforeInsert });

    await type(textarea(container), 'Create a section about evening candles');
    await click(requireButton(container, en('affiliates.copilot.send')));
    const insert = await waitFor(() => button(container, en('affiliates.copilot.insert_section')), 'insert button');

    const preview = container.querySelector(`[role="region"][aria-label="${en('affiliates.copilot.section_preview_label')}"]`);
    expect(preview?.querySelector('h2')?.textContent).toBe('My candle corner');
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('https://images.unsplash.com/photo-1');
    expect(preview?.textContent).toContain('Jane Doe');
    expect(preview?.textContent).toContain('My picks');
    expect(preview?.textContent).toContain('2 store products');
    expect(container.textContent).toContain(en('affiliates.copilot.section_skipped'));

    await click(insert);
    expect(onBeforeInsert).toHaveBeenCalledTimes(1);
    expect(editorApi.insertBlocks).not.toHaveBeenCalled();

    await act(async () => {
      releaseSave();
      await sleep(5);
    });

    expect(editorApi.insertBlocks).toHaveBeenCalledTimes(1);
    expect(editorApi.insertBlocks).toHaveBeenCalledWith(SECTION_NODES);
    expect(button(container, en('affiliates.copilot.section_inserted'))?.disabled).toBe(true);
    expect(status(container)).toBe(en('affiliates.copilot.section_inserted'));
  });

  it('inserts into the editor the page holds after onBeforeInsert, even when it was replaced meanwhile', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'generate_storefront_section',
          output: { ok: true, title: 'My candle corner', nodes: SECTION_NODES.slice(0, 2), productIds: [], imageCount: 0 },
        },
        { type: 'finish' },
      ]),
    );
    const firstEditor = editorApiMock();
    const secondEditor = editorApiMock();
    let releaseSave: () => void = () => undefined;
    const onBeforeInsert = vi.fn(() => new Promise<void>((resolve) => (releaseSave = resolve)));
    const { container, rerender } = await renderPanel({ editorApi: firstEditor, onBeforeInsert });

    await type(textarea(container), 'A section please');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await click(await waitFor(() => button(container, en('affiliates.copilot.insert_section')), 'insert button'));
    await rerender({ editorApi: secondEditor, onBeforeInsert });
    await act(async () => {
      releaseSave();
      await sleep(5);
    });

    expect(firstEditor.insertBlocks).not.toHaveBeenCalled();
    expect(secondEditor.insertBlocks).toHaveBeenCalledWith(SECTION_NODES.slice(0, 2));
  });

  it('reports a failed save before inserting and inserts nothing', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'generate_storefront_section',
          output: { ok: true, title: 'My candle corner', nodes: SECTION_NODES.slice(0, 2), productIds: [], imageCount: 0 },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock();
    const { container } = await renderPanel({ editorApi, onBeforeInsert: vi.fn(async () => Promise.reject(new Error('save failed'))) });

    await type(textarea(container), 'A section please');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await click(await waitFor(() => button(container, en('affiliates.copilot.insert_section')), 'insert button'));
    await settle();

    expect(editorApi.insertBlocks).not.toHaveBeenCalled();
    expect(status(container)).toBe(en('affiliates.copilot.insert_failed'));
    expect(button(container, en('affiliates.copilot.insert_section'))?.disabled).toBe(false);
  });

  it('drops section nodes the storefront sanitizer refuses before previewing or inserting them', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'generate_storefront_section',
          output: {
            ok: true,
            title: 'Sneaky',
            nodes: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Click me', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
              { type: 'image', attrs: { src: 'https://evil.example/pixel.gif', alt: 'x' } },
              { type: 'scriptTag', content: [{ type: 'text', text: 'alert(1)' }] },
            ],
            productIds: [],
            imageCount: 0,
            skipped: { productIds: 0, images: 0, blocks: 0 },
          },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock();
    const { container } = await renderPanel({ editorApi });

    await type(textarea(container), 'Make a section');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await click(await waitFor(() => button(container, en('affiliates.copilot.insert_section')), 'insert button'));

    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('img[src*="evil.example"]')).toBeNull();
    const inserted = editorApi.insertBlocks.mock.calls[0]?.[0] as StorefrontBlockNode[];
    expect(JSON.stringify(inserted)).not.toContain('javascript:');
    expect(JSON.stringify(inserted)).not.toContain('evil.example');
    expect(JSON.stringify(inserted)).not.toContain('scriptTag');
  });

  it('polishes the selected text and replaces the selection with the rewrite', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        { type: 'tool-call', toolName: 'rewrite_storefront_copy' },
        {
          type: 'tool-result',
          toolName: 'rewrite_storefront_copy',
          output: { ok: true, text: 'My candles bring calm to every evening.', paragraphs: ['My candles bring calm to every evening.'] },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock('  I like candles they are nice.  ');
    const { container } = await renderPanel({ editorApi });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));
    const replace = await waitFor(() => button(container, en('affiliates.copilot.replace_selection')), 'replace button');

    expect(requestBody()).toEqual({
      messages: [{ role: 'user', content: en('affiliates.copilot.quick_polish_prompt') }],
      locale: 'en',
      selection: 'I like candles they are nice.',
    });

    await click(replace);

    expect(editorApi.replaceSelection).toHaveBeenCalledWith('My candles bring calm to every evening.');
    expect(button(container, en('affiliates.copilot.selection_replaced'))?.disabled).toBe(true);
  });

  it('caps the selection it sends at 4000 characters', async () => {
    fetchMock.mockResolvedValue(streamResponse([{ type: 'finish' }]));
    const { container } = await renderPanel({ editorApi: editorApiMock('y'.repeat(5000)) });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));
    await waitFor(() => fetchMock.mock.calls.length > 0, 'fetch');

    expect(requestBody().selection).toHaveLength(4000);
  });

  it('asks for a selection instead of polishing nothing', async () => {
    const { container } = await renderPanel({ editorApi: editorApiMock('') });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status(container)).toBe(en('affiliates.copilot.polish_needs_selection'));
  });

  it('refuses to replace when the partner no longer has a selection', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'rewrite_storefront_copy',
          output: { ok: true, text: 'Better copy.', paragraphs: ['Better copy.'] },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock('Old copy');
    const { container } = await renderPanel({ editorApi });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));
    const replace = await waitFor(() => button(container, en('affiliates.copilot.replace_selection')), 'replace button');
    editorApi.getSelectedText.mockReturnValue('');
    await click(replace);

    expect(editorApi.replaceSelection).not.toHaveBeenCalled();
    expect(status(container)).toBe(en('affiliates.copilot.replace_needs_selection'));
  });

  it('never replaces a selection across blocks, and keeps the suggestion', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        {
          type: 'tool-result',
          toolName: 'rewrite_storefront_copy',
          output: { ok: true, text: 'Here are the picks I love.', paragraphs: ['Here are the picks I love.'] },
        },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock('These are my picks.');
    const { container } = await renderPanel({ editorApi });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));
    const replace = await waitFor(() => button(container, en('affiliates.copilot.replace_selection')), 'replace button');
    // The partner now selects a paragraph, a product grid and the paragraph after it.
    editorApi.getSelectedText.mockReturnValue('These are my picks.\nEnjoy them.');
    editorApi.canReplaceSelection.mockReturnValue(false);
    await click(replace);

    expect(editorApi.replaceSelection).not.toHaveBeenCalled();
    expect(status(container)).toBe(en('affiliates.copilot.replace_single_block'));
    expect(replace.disabled).toBe(false);
    expect(button(container, en('affiliates.copilot.selection_replaced'))).toBeUndefined();
  });

  it('keeps the suggestion when the editor replaces nothing', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        { type: 'tool-result', toolName: 'rewrite_storefront_copy', output: { ok: true, text: 'Better copy.', paragraphs: ['Better copy.'] } },
        { type: 'finish' },
      ]),
    );
    const editorApi = editorApiMock('Old copy');
    editorApi.replaceSelection.mockReturnValue(false);
    const { container } = await renderPanel({ editorApi });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));
    const replace = await waitFor(() => button(container, en('affiliates.copilot.replace_selection')), 'replace button');
    await click(replace);

    expect(editorApi.replaceSelection).toHaveBeenCalledWith('Better copy.');
    expect(status(container)).toBe(en('affiliates.copilot.error_generic'));
    expect(replace.disabled).toBe(false);
  });

  it('sends no polish request for a selection it could not replace', async () => {
    const editorApi = editorApiMock('My go-to teas\nI reach for these.');
    editorApi.canReplaceSelection.mockReturnValue(false);
    const { container } = await renderPanel({ editorApi });

    await click(requireButton(container, en('affiliates.copilot.quick_polish')));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status(container)).toBe(en('affiliates.copilot.polish_single_block'));
  });

  it('prefills the composer from a quick action and focuses it', async () => {
    const { container } = await renderPanel();

    await click(requireButton(container, en('affiliates.copilot.quick_bio')));

    const field = textarea(container);
    expect(field.value).toBe(`${en('affiliates.copilot.quick_bio_prompt')} `);
    expect(document.activeElement).toBe(field);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends on Enter but not on Shift+Enter, and replays the previous answer as history', async () => {
    fetchMock
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: 'tool-result',
            toolName: 'generate_retailer_bio',
            output: { ok: true, bio: 'First bio.', meta_description: 'First description.' },
          },
          { type: 'text-delta', text: 'Done.' },
          { type: 'finish' },
        ]),
      )
      .mockResolvedValueOnce(streamResponse([{ type: 'text-delta', text: 'Shorter now.' }, { type: 'finish' }]));
    const { container } = await renderPanel();
    const field = textarea(container);

    await type(field, 'Write my bio');
    await pressKey(field, { key: 'Enter', shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();

    await pressKey(field, { key: 'Enter' });
    await waitFor(() => button(container, en('affiliates.copilot.apply_bio')), 'first answer');
    await waitFor(() => !button(container, en('affiliates.copilot.stop')), 'reply finished');

    await type(textarea(container), 'Make it shorter');
    await pressKey(textarea(container), { key: 'Enter' });
    await waitFor(() => container.textContent?.includes('Shorter now.'), 'second answer');

    expect(requestBody(1).messages).toEqual([
      { role: 'user', content: 'Write my bio' },
      { role: 'assistant', content: 'Done.\n\nFirst bio.\n\nFirst description.' },
      { role: 'user', content: 'Make it shorter' },
    ]);
  });

  it.each([
    [429, { 'Retry-After': '120' }, en('affiliates.copilot.error_rate_limited').replace('{minutes}', '2')],
    [429, {}, en('affiliates.copilot.error_rate_limited_later')],
    [403, {}, en('affiliates.copilot.error_forbidden')],
    [503, {}, en('affiliates.copilot.error_unavailable')],
    [400, {}, en('affiliates.copilot.error_invalid_request')],
  ])('shows a localized notice for HTTP %s', async (statusCode, headers, expected) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Cortex AI hourly request limit reached (30 requests per hour for your role).' }), {
        status: statusCode,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes(expected), `notice ${statusCode}`);

    expect(container.textContent).not.toContain('requests per hour');
  });

  it('shows localized copy for failed tool outputs, tool errors and stream errors', async () => {
    fetchMock.mockResolvedValue(
      streamResponse([
        { type: 'tool-result', toolName: 'generate_storefront_section', output: { ok: false, error: 'empty_section' } },
        { type: 'tool-error', toolName: 'rewrite_storefront_copy', message: 'raw server text' },
        { type: 'error', code: 'failed', message: 'raw server text' },
        { type: 'finish' },
      ]),
    );
    const { container } = await renderPanel({}, 'fr');

    await type(textarea(container), 'Bonjour');
    await click(requireButton(container, fr('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes(fr('affiliates.copilot.error_generic')), 'stream error');

    expect(container.textContent).toContain(fr('affiliates.copilot.error_empty_section'));
    expect(container.textContent).toContain(fr('affiliates.copilot.error_tool'));
    expect(container.textContent).not.toContain('raw server text');
  });

  it('shows one localized notice for sections refused past the request cap, and keeps the drafted ones', async () => {
    const drafted = {
      ok: true,
      title: 'My candle corner',
      nodes: SECTION_NODES.slice(0, 2),
      productIds: [],
      imageCount: 0,
      skipped: { productIds: 0, images: 0, blocks: 0 },
    };
    fetchMock.mockResolvedValue(
      streamResponse([
        { type: 'tool-result', toolName: 'generate_storefront_section', output: drafted },
        { type: 'tool-result', toolName: 'generate_storefront_section', output: { ok: false, error: 'section_limit' } },
        { type: 'tool-result', toolName: 'generate_storefront_section', output: { ok: false, error: 'section_limit' } },
        { type: 'tool-error', toolName: 'generate_storefront_section', message: 'raw server text' },
        { type: 'tool-error', toolName: 'generate_storefront_section', message: 'raw server text' },
        { type: 'finish' },
      ]),
    );
    const { container } = await renderPanel({ editorApi: editorApiMock() }, 'fr');

    await type(textarea(container), 'Crée cinq sections');
    await click(requireButton(container, fr('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes(fr('affiliates.copilot.error_section_limit')), 'section limit notice');

    const text = container.textContent ?? '';
    expect(text.split(fr('affiliates.copilot.error_section_limit'))).toHaveLength(2);
    expect(text.split(fr('affiliates.copilot.error_tool'))).toHaveLength(2);
    expect(button(container, fr('affiliates.copilot.insert_section'))).toBeDefined();
  });

  it('shows the network notice when the request cannot be sent', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));

    await waitFor(() => container.textContent?.includes(en('affiliates.copilot.error_network')), 'network notice');
  });

  it('stops a running request, and aborts it on unmount', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    const stopButton = await waitFor(() => button(container, en('affiliates.copilot.stop')), 'stop button');
    // The composer keeps focus and input while a reply streams; only sending waits.
    expect(textarea(container).disabled).toBe(false);
    expect(requireButton(container, en('affiliates.copilot.send')).disabled).toBe(true);
    await click(stopButton);

    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => container.textContent?.includes(en('affiliates.copilot.stopped')), 'stopped notice');

    await type(textarea(container), 'Again');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => signals.length === 2, 'second request');

    const entry = mounted.pop();
    await act(async () => entry?.root.unmount());
    entry?.container.remove();

    expect(signals[1]?.aborted).toBe(true);
  });

  it('clears the conversation with New conversation', async () => {
    fetchMock.mockResolvedValue(streamResponse([{ type: 'text-delta', text: 'Hi!' }, { type: 'finish' }]));
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes('Hi!'), 'reply');
    await waitFor(() => !requireButton(container, en('affiliates.copilot.new_conversation')).disabled, 'idle');
    await click(requireButton(container, en('affiliates.copilot.new_conversation')));

    expect(container.textContent).not.toContain('Hi!');
    expect(container.textContent).toContain(en('affiliates.copilot.empty_state'));
  });
});

// ---------------------------------------------------------------------------------------------
// The visitor's own OpenRouter key on the public sandbox
// ---------------------------------------------------------------------------------------------

const VISITOR_KEY = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;
const SANDBOX_KEYS = Object.keys(AFFILIATES_COPILOT_COPY).filter(
  (key): key is CopyKey => key.includes('.sandbox_') || key.endsWith('_sandbox'),
);

function keyField(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input[type="password"]');
}

function requireKeyField(container: HTMLElement): HTMLInputElement {
  const field = keyField(container);
  if (!field) throw new Error('no key field');
  return field;
}

/** The element ids the key field is described by: its hint, then its status line. */
function describedBy(field: HTMLElement): HTMLElement[] {
  return (field.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element !== null);
}

/** The visible line under the key field (its second description): whether a key is saved, or why a save failed. */
function keyStatusLine(container: HTMLElement): HTMLElement {
  const line = describedBy(requireKeyField(container))[1];
  if (!line) throw new Error('no key status line');
  return line;
}

function keyStatus(container: HTMLElement): string {
  return keyStatusLine(container).textContent ?? '';
}

/** The key field's own polite live region: what the last save or removal did, empty until then. */
function keyAnnouncement(container: HTMLElement): string {
  const region = requireKeyField(container).form?.querySelector('[role="status"]');
  if (!region) throw new Error('no key live region');
  return region.textContent ?? '';
}

async function typeInto(field: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function saveKey(container: HTMLElement, value: string) {
  await typeInto(requireKeyField(container), value);
  await click(requireButton(container, en('affiliates.copilot.sandbox_key_save')));
}

function storedKey(): string | null {
  return window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY);
}

/** Everything a console spy was given, as text (objects as JSON where they serialize). */
function printed(calls: unknown[][]): string {
  return calls
    .flat()
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join('\n');
}

describe('StorefrontCopilotPanel off the sandbox', () => {
  it.each(['', 'false'])(
    'shows no key field, never touches browser storage and keeps the standard unavailable notice (NEXT_PUBLIC_IS_SANDBOX=%j)',
    async (flag) => {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', flag);
      window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
      const storage = [
        vi.spyOn(Storage.prototype, 'getItem'),
        vi.spyOn(Storage.prototype, 'setItem'),
        vi.spyOn(Storage.prototype, 'removeItem'),
      ];
      fetchMock.mockResolvedValue(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
      const { container } = await renderPanel();

      expect(keyField(container)).toBeNull();
      expect(container.querySelectorAll('form')).toHaveLength(1);
      for (const key of SANDBOX_KEYS) expect(container.textContent, key).not.toContain(en(key));

      await type(textarea(container), 'Hello');
      await click(requireButton(container, en('affiliates.copilot.send')));
      await waitFor(() => container.textContent?.includes(en('affiliates.copilot.error_unavailable')), 'unavailable notice');

      expect(container.textContent).not.toContain(en('affiliates.copilot.error_unavailable_sandbox'));
      expect(button(container, en('affiliates.copilot.sandbox_key_go_to_field'))).toBeUndefined();
      for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    },
  );
});

describe('StorefrontCopilotPanel on the sandbox', () => {
  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    // The real header builder: it reads the key the field saved, exactly as in the browser.
    const actual = await vi.importActual<{ buildCortexAiRequestHeaders: () => Record<string, string> }>(
      '../../lib/cortex-ai/sandbox-headers',
    );
    mocks.headers.mockImplementation(actual.buildCortexAiRequestHeaders);
  });

  it("shows a labelled, described password field for the visitor's own key", async () => {
    const { container } = await renderPanel();
    const field = requireKeyField(container);

    expect(container.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(en('affiliates.copilot.sandbox_key_label'));
    expect(describedBy(field)[0]?.textContent).toBe(en('affiliates.copilot.sandbox_key_hint'));
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.maxLength).toBe(512);
    // No name and no form action: even a native submit before hydration cannot put it in a URL.
    expect(field.hasAttribute('name')).toBe(false);
    expect(field.form?.hasAttribute('action')).toBe(false);
    expect(requireButton(container, en('affiliates.copilot.sandbox_key_save')).disabled).toBe(true);
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();
    expect(keyStatus(container)).toBe('');
  });

  it('speaks Québec French under a French provider', async () => {
    const { container } = await renderPanel({}, 'fr');
    const field = requireKeyField(container);

    expect(container.querySelector(`label[for="${field.id}"]`)?.textContent).toBe("Votre clé d'API OpenRouter (démo)");
    expect(describedBy(field)[0]?.textContent).toBe(
      "Elle est enregistrée uniquement dans ce navigateur et n'est envoyée qu'avec les demandes aux assistants IA de ce site.",
    );
    expect(button(container, fr('affiliates.copilot.sandbox_key_save'))).toBeDefined();
  });

  it('keeps the field on the page background, so its muted hint keeps its contrast', async () => {
    const { container } = await renderPanel();
    const form = requireKeyField(container).form;

    expect(form?.className).toContain('bg-background');
    expect(form?.className).not.toContain('bg-muted');
  });

  it('says nothing on load when a key is already saved: the saved state is a plain line, not a live region', async () => {
    window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
    const { container } = await renderPanel();
    const line = keyStatusLine(container);

    expect(line.textContent).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(line.hasAttribute('role')).toBe(false);
    expect(line.hasAttribute('aria-live')).toBe(false);
    expect(keyAnnouncement(container)).toBe('');
    const region = requireKeyField(container).form?.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.className).toBe('sr-only');
  });

  it('announces a save, a removal and a refused key once, through the live region', async () => {
    const { container } = await renderPanel();

    await saveKey(container, VISITOR_KEY);
    expect(keyAnnouncement(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));

    await click(requireButton(container, en('affiliates.copilot.sandbox_key_forget')));
    expect(keyAnnouncement(container)).toBe(en('affiliates.copilot.sandbox_key_forgotten'));

    await saveKey(container, 'sk-or-v1');
    expect(keyAnnouncement(container)).toBe(en('affiliates.copilot.sandbox_key_invalid'));

    // Typing again clears the last result.
    await typeInto(requireKeyField(container), VISITOR_KEY);
    expect(keyAnnouncement(container)).toBe('');
  });

  it('drops a "saved" result once another tab removes the key', async () => {
    const { container } = await renderPanel();
    await saveKey(container, VISITOR_KEY);

    await act(async () => {
      window.localStorage.removeItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY }));
    });

    expect(keyStatus(container)).toBe('');
    expect(keyAnnouncement(container)).toBe('');
  });

  it('drops a "removed" result once another tab saves a key', async () => {
    window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
    const { container } = await renderPanel();
    await click(requireButton(container, en('affiliates.copilot.sandbox_key_forget')));

    await act(async () => {
      window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY }));
    });

    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(keyAnnouncement(container)).toBe('');
  });

  it('saves the key to the storage entry the CMS Cortex settings use, then forgets it', async () => {
    window.localStorage.setItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY, '{"modelId":"openai/gpt-5-mini"}');
    const { container } = await renderPanel();

    await saveKey(container, `  ${VISITOR_KEY}  `);

    expect(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY).toBe('cortex_ai_sandbox_openrouter_api_key');
    expect(storedKey()).toBe(VISITOR_KEY);
    expect(requireKeyField(container).value).toBe('');
    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(container.textContent).not.toContain(VISITOR_KEY);

    await click(requireButton(container, en('affiliates.copilot.sandbox_key_forget')));

    expect(storedKey()).toBeNull();
    // As the CMS settings' "Clear" does: the model chosen for that key goes with it.
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY)).toBeNull();
    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_forgotten'));
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();
    expect(document.activeElement).toBe(requireKeyField(container));
  });

  it('sends the saved key only as the copilot request header, and never logs it', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    fetchMock.mockResolvedValue(streamResponse([{ type: 'text-delta', text: 'Hi!' }, { type: 'finish' }]));
    const { container } = await renderPanel();

    await saveKey(container, VISITOR_KEY);
    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes('Hi!'), 'reply');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/affiliates/cortex');
    expect((init.headers as Record<string, string>)['x-sandbox-openrouter-key']).toBe(VISITOR_KEY);
    expect(String(init.body)).not.toContain(VISITOR_KEY);
    expect(window.location.href).not.toContain(VISITOR_KEY);
    for (const spy of consoleSpies) expect(printed(spy.mock.calls)).not.toContain(VISITOR_KEY);
  });

  it('uses a key the CMS Cortex settings already saved in this browser', async () => {
    window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
    fetchMock.mockResolvedValue(streamResponse([{ type: 'finish' }]));
    const { container } = await renderPanel();

    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeDefined();
    expect(requireKeyField(container).value).toBe('');

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => fetchMock.mock.calls.length > 0, 'fetch');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-sandbox-openrouter-key']).toBe(VISITOR_KEY);
  });

  it.each([
    ['a truncated key', 'sk-or-v1-a1b2…c3d4e5f6'],
    ['spaces inside', 'sk-or-v1 a1b2 c3d4 e5f6'],
    ['too short', 'sk-or-v1'],
  ])('refuses %s before storing anything', async (_label, value) => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { container } = await renderPanel();

    await saveKey(container, value);

    expect(setItem).not.toHaveBeenCalled();
    expect(storedKey()).toBeNull();
    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_invalid'));
    expect(requireKeyField(container).getAttribute('aria-invalid')).toBe('true');
    // The red pair of the CMS affiliates screens, which keeps its contrast in both themes.
    expect(keyStatusLine(container).className.split(' ')).toEqual(
      expect.arrayContaining(['font-medium', 'text-red-800', 'dark:text-red-300']),
    );

    await typeInto(requireKeyField(container), VISITOR_KEY);
    expect(requireKeyField(container).hasAttribute('aria-invalid')).toBe(false);
    expect(keyStatus(container)).toBe('');
    expect(keyStatusLine(container).className).not.toContain('text-red-800');
  });

  it('reports blocked site storage instead of failing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    const { container } = await renderPanel();

    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();
    await saveKey(container, VISITOR_KEY);

    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_storage_failed'));
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();
  });

  it('points to the key field when the assistant is unavailable and no key is saved', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    const goToField = await waitFor(() => button(container, en('affiliates.copilot.sandbox_key_go_to_field')), 'key button');

    expect(container.querySelector('[role="log"]')?.textContent).toContain(en('affiliates.copilot.error_unavailable_sandbox'));
    expect(container.textContent).not.toContain(en('affiliates.copilot.error_unavailable'));
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('x-sandbox-openrouter-key');

    await click(goToField);

    expect(document.activeElement).toBe(requireKeyField(container));
  });

  it('keeps the standard unavailable notice when a key is saved', async () => {
    window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
    fetchMock.mockResolvedValue(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const { container } = await renderPanel();

    await type(textarea(container), 'Hello');
    await click(requireButton(container, en('affiliates.copilot.send')));
    await waitFor(() => container.textContent?.includes(en('affiliates.copilot.error_unavailable')), 'unavailable notice');

    expect(container.textContent).not.toContain(en('affiliates.copilot.error_unavailable_sandbox'));
    expect(button(container, en('affiliates.copilot.sandbox_key_go_to_field'))).toBeUndefined();
  });

  it('follows a key saved or removed in another tab', async () => {
    const { container } = await renderPanel();
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();

    await act(async () => {
      window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY }));
    });
    expect(keyStatus(container)).toBe(en('affiliates.copilot.sandbox_key_saved'));
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeDefined();

    await act(async () => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(keyStatus(container)).toBe('');
    expect(button(container, en('affiliates.copilot.sandbox_key_forget'))).toBeUndefined();
  });
});
