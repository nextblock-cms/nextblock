// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * On the sandbox every site-scripts action refuses (../actions.test.ts), so the screen says why and
 * disables each control that would call one: Add, Save, Enable/Disable, Delete and Restore, each
 * described by the note. Edit stays usable (it only opens the editor, whose Save is disabled).
 */

vi.mock('../actions', () => ({
  createSiteScript: vi.fn(),
  deleteSiteScript: vi.fn(),
  revertSiteScript: vi.fn(),
  setSiteScriptActive: vi.fn(),
  updateSiteScript: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import type { SiteScript } from '../../../../../lib/site-scripts/types';
import type { SiteScriptRevision } from '../../../../../lib/site-scripts/revisions';
import SiteScriptManager from './SiteScriptManager';

const NOTE = 'Site scripts and tag managers are turned off in the sandbox: they would run for every visitor.';
const NOTE_ID = 'site-scripts-sandbox-note';

const SCRIPT: SiteScript = {
  id: 'script-1',
  name: 'Chat widget',
  description: null,
  code: 'console.log(1);',
  src: null,
  placement: 'body_end',
  load_strategy: 'default',
  is_active: true,
  sort_order: 0,
};

const REVISION: SiteScriptRevision = {
  id: 'revision-1',
  script_id: 'script-1',
  script_name: 'Chat widget',
  revision_type: 'update',
  actor_user_id: 'admin-1',
  source: 'cms',
  summary: null,
  snapshot: { ...SCRIPT },
  created_at: '2026-11-01T12:00:00.000Z',
};

const mounted: Root[] = [];

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(<SiteScriptManager initialRevisions={[REVISION]} initialScripts={[SCRIPT]} />);
  });
  return container;
}

/** The button whose text is `label` (or starts with it, for the history toggle and its entry count). */
function button(container: HTMLElement, label: string, { prefix = false } = {}): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((element) => {
    const text = element.textContent?.trim() ?? '';
    return prefix ? text.startsWith(label) : text === label;
  });
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

/** The controls that call a site-scripts action, opening the history and the editor on the way. */
async function writeControls(container: HTMLElement) {
  const add = button(container, 'Add script');
  const toggle = button(container, 'Disable');
  const remove = button(container, 'Delete');
  await click(button(container, 'History & audit log', { prefix: true }));
  const restore = button(container, 'Restore this version');
  await click(button(container, 'Edit'));
  const save = button(container, 'Save script');
  return { add, toggle, remove, restore, save };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
});

afterEach(async () => {
  for (const root of mounted.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllEnvs();
});

describe('SiteScriptManager', () => {
  it('shows the note on the sandbox and disables every write control, each described by it', async () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
    const container = await mount();

    const note = container.querySelector(`#${NOTE_ID}`);
    expect(note?.tagName).toBe('P');
    expect(note?.textContent).toBe(NOTE);

    // Read before the editor replaces the row (Add is hidden while editing).
    const addDisabled = button(container, 'Add script');
    expect(addDisabled.disabled).toBe(true);
    expect(addDisabled.getAttribute('aria-describedby')).toBe(NOTE_ID);

    const controls = await writeControls(container);
    for (const [name, control] of Object.entries(controls)) {
      expect(control.disabled, name).toBe(true);
      expect(control.getAttribute('aria-describedby'), name).toBe(NOTE_ID);
    }
    // Viewing stays possible: the editor opened, and Cancel closes it.
    expect(button(container, 'Cancel').disabled).toBe(false);
    expect(button(container, 'Cancel').hasAttribute('aria-describedby')).toBe(false);
  });

  it.each(['', 'false', 'TRUE', '1'])('shows no note and keeps every control enabled when NEXT_PUBLIC_IS_SANDBOX=%j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
    const container = await mount();

    expect(container.textContent).not.toContain(NOTE);
    expect(container.querySelector(`#${NOTE_ID}`)).toBeNull();

    const controls = await writeControls(container);
    for (const [name, control] of Object.entries(controls)) {
      expect(control.disabled, name).toBe(false);
      expect(control.hasAttribute('aria-describedby'), name).toBe(false);
    }
    expect(container.querySelector('[aria-describedby]')).toBeNull();
  });
});
