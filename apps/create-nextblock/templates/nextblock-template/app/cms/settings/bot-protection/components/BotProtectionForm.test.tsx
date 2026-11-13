// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bot-protection form on the public sandbox (2026-11-03). The sandbox stores no captcha secret
 * and never hands the stored one to the form (actions.test.ts), so the secret field is always
 * empty there. It renders disabled and optional, described by a note with the refusal's sentence:
 * a required empty field would block every provider or site key save. Off the sandbox ('',
 * 'false', 'TRUE', '1') the field is required and the markup is what it was.
 */

const mocks = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('../actions', () => ({ updateBotProtectionSettings: mocks.update }));
vi.mock('../../../../../hooks/use-hotkeys', () => ({ useHotkeys: () => undefined }));
vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Alert: Pass,
    AlertDescription: Pass,
    Button: ({ children, variant: _variant, ...props }: Record<string, any>) => <button {...props}>{children}</button>,
    Input: (props: Record<string, unknown>) => <input {...props} />,
    Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
    Spinner: () => null,
  };
});

import BotProtectionForm from './BotProtectionForm';
import { SANDBOX_SECRET_NOTE_ID, SANDBOX_SECRET_REFUSED } from '../sandbox';

const OFF_SANDBOX = ['', 'false', 'TRUE', '1'] as const;
const TURNSTILE = { provider: 'turnstile' as const, siteKey: '0x4AAAAAAAB-site', secretKey: '' };

function dom(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, 'text/html');
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** Mounts the form, submits it the way the Save button does, and returns what the action got. */
async function submit(settings: typeof TURNSTILE): Promise<FormData | null> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<BotProtectionForm initialSettings={settings} />);
  });
  await act(async () => {
    container?.querySelector('form')?.requestSubmit();
  });
  const call = mocks.update.mock.calls[0];
  return call ? (call[0] as FormData) : null;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
  mocks.update.mockReset().mockResolvedValue({ ok: true, message: 'Bot protection settings updated successfully.' });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllEnvs();
});

describe('on the sandbox (NEXT_PUBLIC_IS_SANDBOX=true)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');
  });

  it('renders the secret field disabled and optional, described by the note', () => {
    const doc = dom(renderToStaticMarkup(<BotProtectionForm initialSettings={TURNSTILE} />));
    const secret = doc.getElementById('secretKey');
    expect(secret?.hasAttribute('disabled')).toBe(true);
    expect(secret?.hasAttribute('required')).toBe(false);
    expect(secret?.getAttribute('aria-describedby')).toBe(SANDBOX_SECRET_NOTE_ID);
    expect(doc.getElementById(SANDBOX_SECRET_NOTE_ID)?.textContent).toBe(SANDBOX_SECRET_REFUSED);
    expect(SANDBOX_SECRET_REFUSED).toBe('The sandbox cannot store captcha secret keys.');
    // The provider and site key stay editable.
    expect(doc.getElementById('siteKey')?.hasAttribute('disabled')).toBe(false);
    expect(doc.getElementById('provider')?.hasAttribute('disabled')).toBe(false);
  });

  it('still submits a provider and site key save, with the secret left empty', async () => {
    const formData = await submit(TURNSTILE);
    expect(formData?.get('provider')).toBe('turnstile');
    expect(formData?.get('siteKey')).toBe('0x4AAAAAAAB-site');
    expect(formData?.get('secretKey')).toBe('');
  });
});

describe.each(OFF_SANDBOX)('off the sandbox (NEXT_PUBLIC_IS_SANDBOX=%j): unchanged', (value) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
  });

  it('keeps the secret field required, with no note', () => {
    const markup = renderToStaticMarkup(<BotProtectionForm initialSettings={{ ...TURNSTILE, secretKey: 'stored-secret' }} />);
    const secret = dom(markup).getElementById('secretKey');
    expect(secret?.hasAttribute('required')).toBe(true);
    expect(secret?.hasAttribute('disabled')).toBe(false);
    expect(markup).not.toContain('aria-describedby');
    expect(markup).not.toContain(SANDBOX_SECRET_NOTE_ID);

    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', '');
    expect(renderToStaticMarkup(<BotProtectionForm initialSettings={{ ...TURNSTILE, secretKey: 'stored-secret' }} />)).toBe(markup);
  });

  it('still blocks a save whose secret field is empty, as before', async () => {
    await expect(submit(TURNSTILE)).resolves.toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
