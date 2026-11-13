import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db';
import { AFFILIATE_RETAILER_ROLE } from '@nextblock-cms/affiliates';

import { AuthProvider, useAuth } from './AuthContext';

type Profile = Database['public']['Tables']['profiles']['Row'];

function Probe() {
  const { isRetailer, isAdmin, isWriter, isUserRole } = useAuth();
  return <output>{`retailer=${isRetailer} admin=${isAdmin} writer=${isWriter} user=${isUserRole}`}</output>;
}

function flagsFor(role: string | null): string {
  // The generated user_role type predates migration 02029's RTL value, hence the cast.
  const profile = role === null ? null : ({ id: 'user-1', role, full_name: 'Someone' } as unknown as Profile);
  const html = renderToStaticMarkup(
    <AuthProvider serverUser={{ id: 'user-1' } as User} serverProfile={profile}>
      <Probe />
    </AuthProvider>,
  );
  return html.replace(/<\/?output>/g, '');
}

function PortalProbe() {
  const { isPartnerPortalActive } = useAuth();
  return <output>{`portal=${isPartnerPortalActive}`}</output>;
}

function portalFlag(isPartnerPortalActive?: boolean): string {
  const html = renderToStaticMarkup(
    <AuthProvider serverUser={{ id: 'user-1' } as User} serverProfile={null} isPartnerPortalActive={isPartnerPortalActive}>
      <PortalProbe />
    </AuthProvider>,
  );
  return html.replace(/<\/?output>/g, '');
}

describe('AuthProvider partner portal flag', () => {
  it('is off unless the layout says the Affiliates package is active', () => {
    expect(portalFlag()).toBe('portal=false');
    expect(portalFlag(false)).toBe('portal=false');
    expect(portalFlag(true)).toBe('portal=true');
  });
});

describe('AuthProvider role flags', () => {
  it('flags a partner account (the role the affiliates package defines)', () => {
    expect(AFFILIATE_RETAILER_ROLE).toBe('RTL');
    expect(flagsFor(AFFILIATE_RETAILER_ROLE)).toBe('retailer=true admin=false writer=false user=false');
  });

  it('keeps every other role off the partner flag', () => {
    expect(flagsFor('ADMIN')).toBe('retailer=false admin=true writer=false user=false');
    expect(flagsFor('WRITER')).toBe('retailer=false admin=false writer=true user=false');
    expect(flagsFor('USER')).toBe('retailer=false admin=false writer=false user=true');
    expect(flagsFor('rtl')).toBe('retailer=false admin=false writer=false user=false');
    expect(flagsFor(null)).toBe('retailer=false admin=false writer=false user=false');
  });
});
