// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY,
  CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY,
  CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY,
} from '../lib/cortex-ai/sandbox-headers';

const actions = vi.hoisted(() => ({ signOutAction: vi.fn(async () => undefined) }));

const state = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-1', email: 'jane@example.com' } as { id: string; email: string } | null,
    profile: { full_name: 'Jane Partner', avatar_url: null } as { full_name: string; avatar_url: string | null } | null,
    isAdmin: false,
    isWriter: false,
    isRetailer: true,
    isPartnerPortalActive: true,
  },
  lang: 'en',
  translations: {} as Record<string, string>,
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('../app/actions', () => ({ signOutAction: actions.signOutAction }));
vi.mock('@nextblock-cms/utils', () => ({
  useTranslations: () => ({ lang: state.lang, t: (key: string) => state.translations[key] ?? key }),
}));

// The real menu renders its items in a portal only once opened; flatten it so the items render.
// Items keep their click handler (sign-out); a handler never shows in the static markup.
vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <div onClick={onClick}>{children}</div>
    ),
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: Pass,
  };
});
vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  return { Avatar: Pass, AvatarFallback: Pass, AvatarImage: () => null };
});
vi.mock('@nextblock-cms/ui', () => ({
  Button: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import AuthButton from './header-auth';

function render() {
  return renderToStaticMarkup(<AuthButton />);
}

describe('header account menu: partner portal link', () => {
  beforeEach(() => {
    state.auth = {
      ...state.auth,
      user: { id: 'user-1', email: 'jane@example.com' },
      isAdmin: false,
      isWriter: false,
      isRetailer: true,
      isPartnerPortalActive: true,
    };
    state.lang = 'en';
    state.translations = {};
  });

  it('links a partner to the portal, without prefetching it', () => {
    const html = render();
    expect(html).toContain('href="/portal/retailer"');
    expect(html).toContain('Partner portal');
    expect(html).not.toContain('href="/cms/dashboard"');
  });

  it('falls back to Québec French when the key is not seeded', () => {
    state.lang = 'fr-CA';
    expect(render()).toContain('Portail partenaire');
  });

  it('uses the seeded translation when there is one', () => {
    state.translations = { partner_portal: 'Espace partenaire' };
    expect(render()).toContain('Espace partenaire');
  });

  it('hides the portal link while the Affiliates package is inactive (the portal sends partners home)', () => {
    state.auth = { ...state.auth, isRetailer: true, isPartnerPortalActive: false };
    const html = render();
    expect(html).not.toContain('/portal/retailer');
    expect(html).not.toContain('Partner portal');
    expect(html).toContain('href="/profile"');
  });

  it('shows no portal link to customers or staff', () => {
    state.auth = { ...state.auth, isRetailer: false };
    expect(render()).not.toContain('/portal/retailer');

    state.auth = { ...state.auth, isRetailer: false, isAdmin: true };
    const staff = render();
    expect(staff).not.toContain('/portal/retailer');
    expect(staff).toContain('href="/cms/dashboard"');
  });
});

describe('header account menu: sign-out on the shared sandbox accounts (2026-11-03)', () => {
  // Every sandbox visitor signs in to the same demo accounts, and keeps their own OpenRouter key in
  // this browser. Sign-out forgets it before the action runs; off the sandbox it touches no storage.
  const VISITOR_KEY = 'sk-or-v1-visitor-own-key';
  const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
  const STORAGE_METHODS = ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const;
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    state.auth = { ...state.auth, user: { id: 'user-1', email: 'demo@nextblock.dev' }, isAdmin: true, isRetailer: false };
    state.lang = 'en';
    state.translations = {};
    actions.signOutAction.mockClear();
    window.localStorage.clear();
    window.localStorage.setItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY, VISITOR_KEY);
    window.localStorage.setItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY, '{"modelId":"openai/gpt-5-mini"}');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    window.localStorage.clear();
  });

  async function mountMenu() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<AuthButton />);
    });
  }

  async function clickSignOut() {
    const label = Array.from(container?.querySelectorAll('span') ?? []).find((span) => span.textContent === 'sign_out');
    expect(label).toBeDefined();
    await act(async () => {
      label?.parentElement?.click();
    });
  }

  it('on the sandbox, removes the visitor key, model and Cortex chat before signing out', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    window.localStorage.setItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY, '[]');
    await mountMenu();
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');

    await clickSignOut();

    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CORTEX_AGENT_CHAT_THREADS_STORAGE_KEY)).toBeNull();
    expect(actions.signOutAction).toHaveBeenCalledTimes(1);
    // The key, the model, the chat threads and the legacy session chat (clearSandboxCortexKey).
    expect(removeItem).toHaveBeenCalledTimes(4);
    expect(Math.max(...removeItem.mock.invocationCallOrder)).toBeLessThan(actions.signOutAction.mock.invocationCallOrder[0]);
  });

  it.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j), signs out without touching storage', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    await mountMenu();
    const methods = STORAGE_METHODS.map((name) => vi.spyOn(Storage.prototype, name));
    const accessor = vi.spyOn(window, 'localStorage', 'get');

    await clickSignOut();

    expect(actions.signOutAction).toHaveBeenCalledTimes(1);
    for (const spy of methods) expect(spy).not.toHaveBeenCalled();
    expect(accessor).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(window.localStorage.getItem(CORTEX_AI_SANDBOX_API_KEY_STORAGE_KEY)).toBe(VISITOR_KEY);
  });
});
