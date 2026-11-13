import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * /forgot-password does not exist on the public sandbox, which shares its demo accounts and sends
 * no account email (forgotPasswordAction refuses there; /sign-in hides the link). The real
 * notFound() runs, so the page throws Next's 404 signal.
 */

const state = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('@nextblock-cms/utils', async () => {
  const actual = await vi.importActual<typeof import('@nextblock-cms/utils')>('@nextblock-cms/utils');
  return { ...actual, useTranslations: () => ({ lang: 'en', t: (key: string) => key }) };
});
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return { ...actual, useSearchParams: () => state.params };
});
vi.mock('../../actions', () => ({ forgotPasswordAction: async () => undefined }));

import ForgotPasswordPage from './page';

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/forgot-password', () => {
  it('answers 404 on the sandbox', () => {
    vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', 'true');

    const error = thrownBy(() => ForgotPasswordPage());
    expect(error).toBeInstanceOf(Error);
    expect((error as { digest?: unknown }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('renders the reset form everywhere else', () => {
    for (const value of ['', 'false']) {
      vi.stubEnv('NEXT_PUBLIC_IS_SANDBOX', value);
      state.params = new URLSearchParams('error=Could not reset password');
      const html = renderToStaticMarkup(<ForgotPasswordPage />);

      expect(html).toContain('<h1 class="text-2xl font-medium">reset_password</h1>');
      expect(html).toMatch(/<input type="email"[^>]*name="email"/);
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*>reset_password<\/button>/);
      expect(html).toContain('<div role="alert" class="text-destructive border-l-2 border-destructive px-4">Could not reset password</div>');
    }
  });
});
