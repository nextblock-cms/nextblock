import { describe, expect, it } from 'vitest';
import { AFFILIATE_PORTAL_PATH, AFFILIATE_RETAILER_ROLE } from '@nextblock-cms/affiliates';
import { resolvePostAuthRedirect } from './auth-redirects';

type AuthProfile = Parameters<typeof resolvePostAuthRedirect>[0];

// resolvePostAuthRedirect only honours a requested path when it is a safe SITE-RELATIVE path.
// An open-redirect payload must fall through to a safe internal default, never be returned.
const completeUser = { role: 'USER', full_name: 'A Customer' } as const;

// The generated user_role type predates migration 02029's RTL value, hence the cast.
const partner = (fullName: string | null = 'A Partner') =>
  ({ role: AFFILIATE_RETAILER_ROLE, full_name: fullName }) as unknown as AuthProfile;

const OPEN_REDIRECT_PAYLOADS = [
  '//evil.com',
  '/\\evil.com',
  '\\/evil.com',
  'https://evil.com',
  'http://evil.com',
  '/%2F%2Fevil.com',
  '/path\nwith-control',
  'javascript:alert(1)',
  '   /leading-space',
];

describe('resolvePostAuthRedirect open-redirect guard', () => {
  it('honours a clean internal path', () => {
    expect(resolvePostAuthRedirect(completeUser, '/product/thing')).toBe('/product/thing');
  });

  it.each(OPEN_REDIRECT_PAYLOADS)('never redirects off-site for %p', (payload) => {
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

describe('resolvePostAuthRedirect for partners (RTL)', () => {
  it('sends a partner to the portal by default', () => {
    expect(AFFILIATE_PORTAL_PATH).toBe('/portal/retailer');
    expect(resolvePostAuthRedirect(partner(), null)).toBe(AFFILIATE_PORTAL_PATH);
    expect(resolvePostAuthRedirect(partner(), undefined)).toBe(AFFILIATE_PORTAL_PATH);
    expect(resolvePostAuthRedirect(partner(), '')).toBe(AFFILIATE_PORTAL_PATH);
  });

  it('honours the page a partner asked for', () => {
    expect(resolvePostAuthRedirect(partner(), '/portal/retailer/payouts')).toBe('/portal/retailer/payouts');
    expect(resolvePostAuthRedirect(partner(), '/partners/jane')).toBe('/partners/jane');
  });

  it('replaces a CMS dashboard target (partners have no CMS access) with the portal', () => {
    expect(resolvePostAuthRedirect(partner(), '/cms/dashboard')).toBe(AFFILIATE_PORTAL_PATH);
    expect(resolvePostAuthRedirect(partner(), '/cms/dashboard/stats')).toBe(AFFILIATE_PORTAL_PATH);
  });

  it('lets the password-reset flow win', () => {
    expect(resolvePostAuthRedirect(partner(), '/profile/password')).toBe('/profile/password');
  });

  it('never sends a partner to the customer profile step, even without a full name', () => {
    expect(resolvePostAuthRedirect(partner(null), null)).toBe(AFFILIATE_PORTAL_PATH);
    expect(resolvePostAuthRedirect(partner(''), '/portal/retailer/storefront')).toBe('/portal/retailer/storefront');
  });

  it.each(OPEN_REDIRECT_PAYLOADS)('falls back to the portal for %p', (payload) => {
    expect(resolvePostAuthRedirect(partner(), payload)).toBe(AFFILIATE_PORTAL_PATH);
  });

  it('matches the role exactly (no case folding, other roles unchanged)', () => {
    const lowercase = { role: 'rtl', full_name: 'A Partner' } as unknown as AuthProfile;
    expect(resolvePostAuthRedirect(lowercase, null)).toBe('/');
    expect(resolvePostAuthRedirect({ role: 'USER', full_name: null }, null)).toBe('/profile');
    expect(resolvePostAuthRedirect({ role: 'WRITER', full_name: 'W' }, null)).toBe('/cms/dashboard');
  });
});
