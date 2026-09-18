'use client';

import type { Database } from '@nextblock-cms/db';
import { cn } from '@nextblock-cms/utils';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import Header from './Header';
import FooterNavigation from './FooterNavigation';
import { EnvVarWarning } from './env-var-warning';
import { SandboxBanner } from './SandboxBanner';
import { ThemeSwitcher } from './theme-switcher';
import { useLabel } from '../lib/i18n/use-label';

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];
type Logo =
  Database['public']['Tables']['logos']['Row'] & {
    media: Database['public']['Tables']['media']['Row'] | null;
  };

type AppBrandingContextValue = {
  logo: Logo | null;
  siteTitle: string;
};

const AppBrandingContext = createContext<AppBrandingContextValue>({
  logo: null,
  siteTitle: 'Nextblock',
});

export function useAppBranding() {
  return useContext(AppBrandingContext);
}

type CorporateFooter = {
  legalName: string;
  address: string;
  supportEmail: string;
};

type AppShellProps = {
  canAccessCms: boolean;
  children: ReactNode;
  copyrightText: string;
  corporateFooter?: CorporateFooter;
  footerNavItems: NavigationItem[];
  hasSupabaseEnv: boolean;
  headerNavItems: NavigationItem[];
  isDraftModeEnabled: boolean;
  isEcommerceActive: boolean;
  logo: Logo | null;
  showFooterAttribution?: boolean;
  siteTitle: string;
};

export function AppShell({
  canAccessCms,
  children,
  copyrightText,
  corporateFooter,
  footerNavItems,
  hasSupabaseEnv,
  headerNavItems,
  isDraftModeEnabled,
  isEcommerceActive,
  logo,
  showFooterAttribution = true,
  siteTitle,
}: AppShellProps) {
  const pathname = usePathname() || '';
  const isCmsRequest = pathname.startsWith('/cms');
  const isSetupRequest = pathname === '/setup' || pathname.startsWith('/setup/');
  const branding = useMemo(() => ({ logo, siteTitle }), [logo, siteTitle]);
  const label = useLabel();
  const skipLabel = label('skip_to_content', 'Skip to main content', 'Aller au contenu principal');

  // The first-boot setup wizard renders on its own clean, chrome-free page: no header
  // or footer, and crucially no EnvVarWarning — the whole point of /setup is to supply
  // the very env vars that warning complains about.
  if (isSetupRequest) {
    return (
      <AppBrandingContext.Provider value={branding}>
        <main className="min-h-screen bg-background">{children}</main>
      </AppBrandingContext.Provider>
    );
  }

  return (
    <AppBrandingContext.Provider value={branding}>
      {/* First focusable element on every page. Kept off-screen with a transform (not
          `sr-only`, whose `position` would fight `fixed`) until it receives keyboard focus. */}
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[100] -translate-y-[200%] rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow-lg ring-2 ring-ring transition-transform focus-visible:translate-y-0"
      >
        {skipLabel}
      </a>
      {process.env.NEXT_PUBLIC_IS_SANDBOX === 'true' && !isCmsRequest && <SandboxBanner />}
      <div
        className={cn(
          'text-foreground flex w-full flex-col',
          isCmsRequest
            ? 'h-[100dvh] overflow-hidden bg-slate-50 dark:bg-slate-950'
            : 'min-h-screen bg-background'
        )}
      >
        <div
          className={cn(
            'flex min-h-0 w-full flex-1 flex-col',
            !isCmsRequest && 'items-center'
          )}
        >
          <nav
            aria-label={label('main_navigation', 'Main navigation', 'Navigation principale')}
            className="w-full flex justify-center border-b border-b-foreground/10 h-16 shrink-0"
          >
            <div className="w-full max-w-7xl flex justify-between items-center p-3 px-5 text-sm">
              {!hasSupabaseEnv ? (
                <EnvVarWarning />
              ) : (
                <Header
                  navItems={headerNavItems}
                  canAccessCms={canAccessCms}
                  isDraftModeEnabled={isDraftModeEnabled}
                  logo={logo}
                  siteTitle={siteTitle}
                  isEcommerceActive={isEcommerceActive}
                />
              )}
            </div>
          </nav>
          <main
            id="main-content"
            tabIndex={-1}
            className={cn(
              'w-full outline-hidden',
              isCmsRequest ? 'flex flex-1 min-h-0 overflow-hidden' : 'flex-grow'
            )}
          >
            {children}
          </main>
          {!isCmsRequest && (
            <footer className="w-full border-t py-6">
              <div className="mx-auto flex flex-col items-center justify-center gap-6 text-center text-xs">
                <FooterNavigation
                  navItems={footerNavItems}
                  ariaLabel={label('footer_navigation', 'Footer navigation', 'Navigation du pied de page')}
                />
                {/* Corporate line: slate-600 alone is ~2.7:1 on the dark background (a
                    Lighthouse contrast failure in dark mode); the mailto link inherits
                    the paragraph colour, so the dark variant covers both. */}
                {corporateFooter &&
                  (corporateFooter.legalName ||
                    corporateFooter.address ||
                    corporateFooter.supportEmail) && (
                    <p className="max-w-2xl text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
                      {[corporateFooter.legalName, corporateFooter.address]
                        .filter(Boolean)
                        .join(' · ')}
                      {corporateFooter.supportEmail && (
                        <>
                          {(corporateFooter.legalName || corporateFooter.address) && ' · '}
                          <a
                            href={`mailto:${corporateFooter.supportEmail}`}
                            className="hover:underline"
                          >
                            {corporateFooter.supportEmail}
                          </a>
                        </>
                      )}
                    </p>
                  )}
                <div className="flex flex-row flex-wrap items-center justify-center gap-x-4 gap-y-2">
                  <p className="text-muted-foreground">{copyrightText}</p>
                  {showFooterAttribution && (
                    <p className="text-muted-foreground">
                      Published with{' '}
                      <a
                        href="https://nextblock.dev"
                        target="_blank"
                        rel="noopener"
                        translate="no"
                        className="font-medium hover:underline"
                      >
                        NextBlock&trade; CMS
                      </a>
                    </p>
                  )}
                  <ThemeSwitcher />
                </div>
              </div>
            </footer>
          )}
        </div>
      </div>
    </AppBrandingContext.Provider>
  );
}
