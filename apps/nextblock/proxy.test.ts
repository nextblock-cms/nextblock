import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// proxy.ts is Next's middleware module: it can only export `proxy` and `config`, and running the
// middleware end to end needs a live Supabase. The role map is therefore read from the source and
// resolved with the same longest-prefix rule getRequiredRolesForPath applies, which is enough to
// pin the contract this file guards: which /cms URLs a WRITER may open and which are ADMIN-only.

type Role = 'ADMIN' | 'WRITER' | 'USER';

function loadCmsRoutePermissions(): Record<string, Role[]> {
  const source = readFileSync(fileURLToPath(new URL('./proxy.ts', import.meta.url)), 'utf8');
  const block = source.match(/const cmsRoutePermissions: Record<string, UserRole\[\]> = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('cmsRoutePermissions map not found in proxy.ts');

  const permissions: Record<string, Role[]> = {};
  for (const entry of block[1].matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) {
    permissions[entry[1]] = entry[2]
      .split(',')
      .map((role) => role.trim().replace(/^'|'$/g, ''))
      .filter(Boolean) as Role[];
  }
  return permissions;
}

// Mirror of getRequiredRolesForPath in proxy.ts (longest matching prefix, segment-aligned).
function getRequiredRolesForPath(permissions: Record<string, Role[]>, pathname: string): Role[] | null {
  const sortedPaths = Object.keys(permissions).sort((a, b) => b.length - a.length);
  for (const specificPath of sortedPaths) {
    if (pathname === specificPath || pathname.startsWith(specificPath + (specificPath === '/' ? '' : '/'))) {
      return permissions[specificPath];
    }
  }
  return null;
}

const permissions = loadCmsRoutePermissions();
const rolesFor = (pathname: string) => getRequiredRolesForPath(permissions, pathname);

describe('proxy.ts cmsRoutePermissions', () => {
  it('parses the map out of the source', () => {
    expect(Object.keys(permissions).length).toBeGreaterThanOrEqual(9);
    expect(permissions['/cms']).toEqual(['WRITER', 'ADMIN']);
    for (const [path, roles] of Object.entries(permissions)) {
      expect(path.startsWith('/cms')).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles.every((role) => role === 'ADMIN' || role === 'WRITER')).toBe(true);
    }
  });

  it.each([
    '/cms',
    '/cms/dashboard',
    '/cms/pages',
    '/cms/pages/12/edit',
    '/cms/posts',
    '/cms/media',
    '/cms/custom-blocks',
    '/cms/messages',
    '/cms/products',
    '/cms/products/new',
    '/cms/products/categories',
    '/cms/products/attributes',
    '/cms/products/inventory',
    '/cms/orders',
    '/cms/settings/security',
    '/cms/settings/security/devices',
  ])('keeps %s open to WRITER (sidebar shows it to writers)', (pathname) => {
    expect(rolesFor(pathname)).toEqual(expect.arrayContaining(['WRITER', 'ADMIN']));
  });

  it.each([
    '/cms/admin',
    '/cms/users',
    '/cms/users/new',
    '/cms/users/abc/edit',
    '/cms/settings',
    '/cms/settings/packages',
    '/cms/settings/taxes',
    '/cms/settings/currencies',
    '/cms/settings/backup-restore',
    '/cms/settings/email',
    '/cms/settings/registration',
    '/cms/settings/cortex-ai',
    '/cms/navigation',
    '/cms/navigation/new',
    '/cms/payments',
    '/cms/shipping',
    '/cms/shipping/zones',
    '/cms/coupons',
    '/cms/coupons/42/edit',
    '/cms/promotions',
  ])('requires ADMIN for %s (sidebar marks it adminOnly)', (pathname) => {
    expect(rolesFor(pathname)).toEqual(['ADMIN']);
  });

  it('matches whole path segments only, so a sibling route is not caught by a shorter prefix', () => {
    expect(rolesFor('/cms/paymentsx')).toEqual(['WRITER', 'ADMIN']);
    expect(rolesFor('/cms/settings-x')).toEqual(['WRITER', 'ADMIN']);
    expect(rolesFor('/cms/settings/securityx')).toEqual(['ADMIN']);
  });

  it('leaves non-/cms paths to the rest of the middleware', () => {
    expect(rolesFor('/')).toBeNull();
    expect(rolesFor('/api/upload/proxy')).toBeNull();
    expect(rolesFor('/profile')).toBeNull();
  });
});
