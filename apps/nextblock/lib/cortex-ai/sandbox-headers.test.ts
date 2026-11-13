// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY,
  CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY,
  CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY,
  CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY,
  CORTEX_SANDBOX_SIGN_OUT_EVENT,
  clearSandboxCortexKey,
} from './sandbox-headers';

/**
 * On the public sandbox each visitor keeps their own OpenRouter key (and model) in this browser,
 * and every visitor signs in to the same demo accounts. Signing out left the key behind, so the
 * next person on a shared machine inherited it (2026-11-03). Sign-out now forgets it first, after
 * telling an open Cortex chat to stop so a streaming reply cannot save the history again; off the
 * sandbox ('', 'false', 'TRUE', '1') sign-out touches no storage and dispatches nothing.
 */

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
const VISITOR_KEY = 'sk-or-v1-visitor-own-key';
const STORED_THREADS = '[{"id":"t-1","messages":[]}]';
// Paths, not `new URL('…', import.meta.url)`: Vite rewrites that literal into an http asset URL here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_METHODS = ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const;

// Every non-test module of the app, read once for the scans below.
const APP_ROOT = path.resolve(HERE, '../..');
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', 'coverage', 'public']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name.startsWith('.') || SKIP_DIRS.has(name) ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The code alone: a comment that names signOutAction() or a storage key is not code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const appModules = sourceFiles(APP_ROOT).map((file) => ({
  file: path.relative(APP_ROOT, file).split(path.sep).join('/'),
  source: stripComments(readFileSync(file, 'utf8')),
}));

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  window.localStorage.clear();
  window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
  window.localStorage.setItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY, '{"modelId":"openai/gpt-5-mini"}');
  window.localStorage.setItem('nextblock_language', 'fr');
  window.localStorage.setItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY, STORED_THREADS);
  window.sessionStorage.setItem(CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY, '[]');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('clearSandboxCortexKey', () => {
  it('removes the visitor key, model and Cortex chat history on the sandbox, and nothing else', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    clearSandboxCortexKey();

    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem('nextblock_language')).toBe('fr');
  });

  it('first tells an open Cortex chat to stop, while its history is still stored', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    // signOutAction's redirect lands after a round trip; a chat still streaming until then would
    // save its threads again unless it stops before they are removed.
    const storedAtDispatch: Array<string | null> = [];
    const onSignOut = () => storedAtDispatch.push(window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY));
    window.addEventListener(CORTEX_SANDBOX_SIGN_OUT_EVENT, onSignOut);
    try {
      clearSandboxCortexKey();
    } finally {
      window.removeEventListener(CORTEX_SANDBOX_SIGN_OUT_EVENT, onSignOut);
    }

    expect(CORTEX_SANDBOX_SIGN_OUT_EVENT).toBe('nextblock:cortex-sandbox-sign-out');
    expect(storedAtDispatch).toEqual([STORED_THREADS]);
    expect(window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY)).toBeNull();
  });

  it('still forgets everything on the sandbox when the event cannot be dispatched', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new TypeError('Illegal invocation');
    });

    expect(() => clearSandboxCortexKey()).not.toThrow();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('never throws on the sandbox when storage is blocked, so sign-out goes ahead', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(() => clearSandboxCortexKey()).not.toThrow();

    vi.restoreAllMocks();
    // Blocked site data throws on the accessor itself, not just on use.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(() => clearSandboxCortexKey()).not.toThrow();
  });

  it.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j), touches no storage and tells no chat to stop', (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const methods = STORAGE_METHODS.map((name) => vi.spyOn(Storage.prototype, name));
    const accessor = vi.spyOn(window, 'localStorage', 'get');
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const onSignOut = vi.fn();
    window.addEventListener(CORTEX_SANDBOX_SIGN_OUT_EVENT, onSignOut);

    clearSandboxCortexKey();

    window.removeEventListener(CORTEX_SANDBOX_SIGN_OUT_EVENT, onSignOut);
    for (const spy of methods) expect(spy).not.toHaveBeenCalled();
    expect(accessor).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)).toBe(VISITOR_KEY);
  });

  it('stays import-free, so any client bundle can call it', () => {
    const source = readFileSync(path.join(HERE, 'sandbox-headers.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('the storage keys are spelled out in sandbox-headers.ts alone', () => {
  // clearSandboxCortexKey() removes the keys this module names. A module with its own copy of a key
  // keeps the old name after a rename, and what it stores there survives sign-out. Every reader
  // imports them instead. (libs/editor's NotionEditor cannot import the app and keeps a copy.)
  const STORAGE_KEYS = [
    CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY,
    CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY,
    CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY,
    CORTEX_AGENT_CHAT_LEGACY_STORAGE_KEY,
  ];
  const HOME = 'lib/cortex-ai/sandbox-headers.ts';
  const SETTINGS_SCREEN = 'app/cms/settings/cortex-ai/CortexAiSettingsClient.tsx';
  const CHAT = 'app/cms/components/CortexGlobalAgentChat.tsx';
  const otherModules = appModules.filter(({ file }) => file !== HOME);

  /** The storage keys a module's code spells out as a string ('…', "…" or `…`). */
  function quotedKeys(source: string) {
    return STORAGE_KEYS.filter((key) => ["'", '"', '`'].some((quote) => source.includes(`${quote}${key}${quote}`)));
  }

  /** True when the module imports from lib/cortex-ai/sandbox-headers (a relative specifier). */
  function importsSandboxHeaders(file: string, source: string) {
    const dir = path.dirname(path.join(APP_ROOT, file));
    return [...source.matchAll(/\bfrom\s+(['"])([^'"]+)\1/g)].some(
      ([, , specifier]) => specifier.startsWith('.') && path.resolve(dir, specifier) === path.join(HERE, 'sandbox-headers')
    );
  }

  it('scans the Cortex settings screen and chat, and finds every key where it is defined (the scan is not vacuous)', () => {
    expect(otherModules.map(({ file }) => file)).toEqual(expect.arrayContaining([SETTINGS_SCREEN, CHAT]));
    const home = appModules.find(({ file }) => file === HOME);
    expect(home && quotedKeys(home.source)).toEqual(STORAGE_KEYS);
  });

  it('no other app module spells out a storage key', () => {
    const copies = otherModules.flatMap(({ file, source }) => quotedKeys(source).map((key) => `${file}: ${key}`));
    expect(copies).toEqual([]);
  });

  it.each([SETTINGS_SCREEN, CHAT])('%s imports the keys from lib/cortex-ai/sandbox-headers', (file) => {
    const mod = otherModules.find((entry) => entry.file === file);
    expect(mod).toBeDefined();
    expect(importsSandboxHeaders(file, mod?.source ?? '')).toBe(true);
  });
});

describe('every client-side sign-out clears the sandbox key first', () => {
  // A scan of the app: a new sign-out handler that calls signOutAction() without
  // clearSandboxCortexKey() just before it, or a form posting straight to signOutAction (no client
  // code runs first), fails here.
  const callers = appModules
    // app/actions.ts defines the action (and is the server side of every call).
    .filter(({ file, source }) => file !== 'app/actions.ts' && /\bsignOutAction\b/.test(source));

  it('finds the known handlers (the scan is not vacuous)', () => {
    expect(callers.map(({ file }) => file)).toEqual(expect.arrayContaining(['components/header-auth.tsx', 'app/cms/CmsClientLayout.tsx']));
  });

  it.each(callers.map(({ file, source }) => [file, source] as const))('%s clears the key right before each signOutAction()', (_file, source) => {
    expect(source).not.toMatch(/\b(?:formAction|action)\s*=\s*\{\s*signOutAction\s*\}/);
    const calls = [...source.matchAll(/\bsignOutAction\s*\(/g)];
    for (const call of calls) {
      const before = source.slice(Math.max(0, (call.index ?? 0) - 240), call.index);
      expect(before).toMatch(/\bclearSandboxCortexKey\(\);\s*(?:return\s+)?(?:await\s+)?$/);
    }
  });
});
