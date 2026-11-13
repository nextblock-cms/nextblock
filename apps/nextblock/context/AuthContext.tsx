// context/AuthContext.tsx
'use client';

import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { User, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@nextblock-cms/db';

type Profile = Database['public']['Tables']['profiles']['Row'];
type UserRole = Database['public']['Enums']['user_role'];

/**
 * The partner (Affiliates) role. Mirrors `AFFILIATE_RETAILER_ROLE` from
 * `@nextblock-cms/affiliates` (AuthContext.test.tsx pins the parity) without importing the
 * library barrel into a provider every page ships. The generated `user_role` type predates
 * migration 02029's `RTL` value, so the role is compared as a string.
 */
const RETAILER_ROLE = 'RTL';

interface AuthProviderProps {
  children: ReactNode;
  serverUser: User | null;
  serverProfile: Profile | null;
  /** The Affiliates package is active (root layout, read for signed-in visitors only). */
  isPartnerPortalActive?: boolean;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  role: UserRole | null;
  isLoading: boolean;
  isAdmin: boolean;
  isWriter: boolean;
  isUserRole: boolean;
  /** A partner account (role `RTL`): the header links it to the partner portal. */
  isRetailer: boolean;
  /**
   * The partner portal is open (the Affiliates package is active). While it is not, the portal
   * sends partners home, so the header hides its link.
   */
  isPartnerPortalActive: boolean;
  supabase: SupabaseClient | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children, serverUser, serverProfile, isPartnerPortalActive = false }: AuthProviderProps) => {
  const [user, setUser] = useState<User | null>(serverUser);
  const [profile, setProfile] = useState<Profile | null>(serverProfile);
  const [role, setRole] = useState<UserRole | null>(serverProfile?.role ?? null);
  const [isLoading] = useState(false);

  useEffect(() => {
    setUser(serverUser);
    setProfile(serverProfile);
    setRole(serverProfile?.role ?? null);
  }, [serverUser, serverProfile]);

  const isAdmin = role === 'ADMIN';
  const isWriter = role === 'WRITER';
  const isUserRole = role === 'USER';
  const isRetailer = String(role) === RETAILER_ROLE;

  const value = useMemo(() => ({
    user,
    profile,
    role,
    isLoading,
    isAdmin,
    isWriter,
    isUserRole,
    isRetailer,
    isPartnerPortalActive,
    supabase: null,
  }), [user, profile, role, isLoading, isAdmin, isWriter, isUserRole, isRetailer, isPartnerPortalActive]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
