// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * /cms/media/[id]/edit hydrates without React error #418. MediaEditForm printed
 * `new Date(created_at).toLocaleString()`, and the server renders the form too (AuthProvider is
 * seeded with the server's user, so it is not "loading"): the HTML carried the server's time zone
 * and locale, the hydrating render the browser's, and React threw a hydration mismatch and rebuilt
 * the page on the client. Here the two time zones are simulated by what toLocaleString() answers
 * during the server render and during hydration.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({ default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} /> }));
vi.mock('../../../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1' }, isLoading: false, isAdmin: true, isWriter: false }),
}));
vi.mock('../../../../hooks/use-hotkeys', () => ({ useHotkeys: () => undefined }));
vi.mock('../../components/CortexAiActiveContext', () => ({ useCortexAiActive: () => false }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@nextblock-cms/ui', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
    Spinner: () => <span />,
    Alert: Pass,
    AlertDescription: Pass,
    Input: (props: Record<string, unknown>) => <input {...props} />,
    Label: ({ children }: { children?: ReactNode }) => <label>{children}</label>,
    Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
  };
});

import MediaEditForm from './MediaEditForm';

const MEDIA = {
  id: 'media-1',
  file_name: 'photo.webp',
  description: 'A photo',
  object_key: 'uploads/photo.webp',
  file_path: 'uploads/photo.webp',
  file_type: 'image/webp',
  size_bytes: 2048,
  variants: [],
  created_at: '2026-11-18T14:05:00+00:00',
} as any;

let mounted: { root: Root; container: HTMLElement } | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe('MediaEditForm hydration', () => {
  it("hydrates without a mismatch when the server's time zone is not the browser's, then shows the browser's", async () => {
    const formAction = async () => ({ success: true });
    const element = <MediaEditForm mediaItem={MEDIA} formAction={formAction} />;

    const toLocaleString = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('18/11/2026 14:05:00 (server)');
    const html = renderToString(element);
    toLocaleString.mockReturnValue('2026-11-18, 9:05:00 a.m. (browser)');

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, element, { onRecoverableError: (error) => recoverableErrors.push(error) });
    });
    mounted = { root: root as Root, container };

    expect(html).toContain('2026-11-18 14:05 UTC');
    expect(html).not.toContain('(server)');
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toContain('2026-11-18, 9:05:00 a.m. (browser)');
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-18T14:05:00.000Z');
  });
});
