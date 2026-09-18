// components/Header.tsx
import type { Database } from '@nextblock-cms/db';
import HeaderAuth from './header-auth';
import LanguageSwitcher from './LanguageSwitcher';
import ResponsiveNav from './ResponsiveNav';
import { CartIcon } from '@nextblock-cms/ecommerce/components/CartIcon';
import { CurrencySwitcher } from '@nextblock-cms/ecommerce/components/CurrencySwitcher';

type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];
type Logo =
  Database['public']['Tables']['logos']['Row'] & {
    media: Database['public']['Tables']['media']['Row'] | null;
  };

interface HeaderProps {
  navItems: NavigationItem[];
  canAccessCms: boolean;
  isDraftModeEnabled: boolean;
  logo: Logo | null;
  currentPageData?: { slug: string; translation_group_id: string | null };
  siteTitle: string;
  isEcommerceActive?: boolean;
}

export default function Header({
  navItems,
  canAccessCms,
  isDraftModeEnabled,
  logo,
  currentPageData,
  siteTitle,
  isEcommerceActive = false,
}: HeaderProps) {
  return (
    <ResponsiveNav
      homeLinkHref="/"
      navItems={navItems}
      canAccessCms={canAccessCms}
      cmsDashboardLinkHref="/cms/dashboard"
      isDraftModeEnabled={isDraftModeEnabled}
      renderHeaderAuth={() => <HeaderAuth />}
      renderLanguageSwitcher={() => <LanguageSwitcher currentPageData={currentPageData} />}
      renderCurrencySwitcher={isEcommerceActive ? () => <CurrencySwitcher /> : undefined}
      logo={logo}
      siteTitle={siteTitle}
      renderCartIcon={isEcommerceActive ? () => <CartIcon /> : undefined}
      isEcommerceActive={isEcommerceActive}
    />
  );
}
