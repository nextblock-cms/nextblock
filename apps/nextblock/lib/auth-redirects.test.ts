import { describe, expect, it } from 'vitest';
import { resolvePostAuthRedirect } from './auth-redirects';

// resolvePostAuthRedirect only honours a requested path when it is a safe SITE-RELATIVE path.
// An open-redirect payload must fall through to a safe internal default, never be returned.
const completeUser = { role: 'USER', full_name: 'A Customer' } as const;

describe('resolvePostAuthRedirect open-redirect guard', () => {
  it('honours a clean internal path', () => {
    expect(resolvePostAuthRedirect(completeUser, '/product/thing')).toBe('/product/thing');
  });

  it.each([
    '//evil.com',
    '/\\evil.com',
    '\\/evil.com',
    'https://evil.com',
    'http://evil.com',
    '/%2F%2Fevil.com',
    '/path\nwith-control',
    'javascript:alert(1)',
    '   /leading-space',
  ])('never redirects off-site for %p', (payload) => {
    const target = resolvePostAuthRedirect(completeUser, payload);
    expect(target.startsWith('/')).toBe(true);
    expect(target.startsWith('//')).toBe(false);
    expect(target).not.toContain('\\');
    expect(target).not.toMatch(/evil\.com/);
    expect(target.toLowerCase()).not.toContain('javascript:');
  });

  it('staff still land on the dashboard with no requested path', () => {
    expect(resolvePostAuthRedirect({ role: 'ADMIN', full_name: 'Admin' }, null)).toBe('/cms/dashboard');
  });
});
