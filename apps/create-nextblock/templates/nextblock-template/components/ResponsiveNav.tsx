"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useState, useEffect, useMemo, useRef } from 'react'
import type { Database } from '@nextblock-cms/db' // Relative path from components/
import { useCurrentContent } from '../context/CurrentContentContext';
import { useTranslations } from '@nextblock-cms/utils';
import { useLabel } from '../lib/i18n/use-label';
import { DeferredGlobalSearch } from './DeferredGlobalSearch';
import { resolveMediaUrl } from '../lib/media/resolveMediaUrl';

type Logo = Database['public']['Tables']['logos']['Row'] & { media: (Database['public']['Tables']['media']['Row'] & { alt_text: string | null }) | null };
type NavigationItem = Database['public']['Tables']['navigation_items']['Row'];
import Image from 'next/image'
import { EyeOff, FilePenLine, Pencil } from 'lucide-react';

const FALLBACK_LOGO_PATH = '/images/nextblock-logo-small.webp';

// Define a type for hierarchical navigation items
interface HierarchicalNavigationItem extends NavigationItem {
  children: HierarchicalNavigationItem[]
}

// SVG Icon for dropdowns/expandable sections
const ChevronDownIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.23 8.27a.75.75 0 01.02-1.06z"
      clipRule="evenodd"
    />
  </svg>
)

// Utility function to build the hierarchy from a flat list
const buildHierarchy = (
  items: NavigationItem[],
): HierarchicalNavigationItem[] => {
  const hierarchy: HierarchicalNavigationItem[] = []
  const itemMap: { [id: string]: HierarchicalNavigationItem } = {}

  items.forEach(item => {
    itemMap[item.id] = { ...item, children: [] }
  })

  items.forEach(item => {
    if (item.parent_id && itemMap[item.parent_id]) {
      itemMap[item.parent_id].children.push(itemMap[item.id])
    } else {
      // Add to root if no parent_id or parent_id not in map (handles orphaned items gracefully)
      if (itemMap[item.id]) {
        // Ensure item itself exists in map
        hierarchy.push(itemMap[item.id])
      }
    }
  })
  return hierarchy
}

interface ResponsiveNavProps {
  homeLinkHref: string
  logo?: Logo | null
  siteTitle: string
  navItems: NavigationItem[]
  canAccessCms: boolean;
  cmsDashboardLinkHref: string;
  isDraftModeEnabled: boolean;
  renderHeaderAuth: () => React.ReactNode;
  renderLanguageSwitcher: () => React.ReactNode;
  renderCurrencySwitcher?: () => React.ReactNode;
  renderCartIcon?: () => React.ReactNode;
  isEcommerceActive?: boolean;
}

function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted ? <>{children}</> : null;
}

/**
 * One desktop menu entry. Opening stays CSS-driven (`group-hover` / `group-focus-within`) so
 * it works before hydration; the state only mirrors it for `aria-expanded` and lets Escape
 * dismiss the flyout (WCAG 1.4.13) until the pointer or focus leaves the entry.
 */
function DesktopNavItem({
  item,
  isSubmenu,
  renderChildren,
}: {
  item: HierarchicalNavigationItem;
  isSubmenu: boolean;
  renderChildren: (items: HierarchicalNavigationItem[]) => React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const hasChildren = item.children.length > 0;
  const linkClassName = `flex items-center justify-between hover:underline px-3 py-2 text-sm text-foreground ${isSubmenu ? 'w-full hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md' : ''}`;

  if (!hasChildren) {
    return (
      <div className={`relative ${isSubmenu ? 'w-full' : ''}`}>
        <Link href={item.url} className={linkClassName}>
          {item.label}
        </Link>
      </div>
    );
  }

  const close = () => {
    setIsOpen(false);
    setIsDismissed(false);
  };

  return (
    <div
      className={`relative group ${isSubmenu ? 'w-full' : ''}`}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={close}
      onFocus={() => setIsOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !isOpen || isDismissed) return;
        event.stopPropagation();
        setIsDismissed(true);
        linkRef.current?.focus();
      }}
    >
      <Link
        ref={linkRef}
        href={item.url}
        className={linkClassName}
        aria-haspopup="true"
        aria-expanded={isOpen && !isDismissed}
      >
        {item.label}
        <ChevronDownIcon
          className={`ml-1 h-4 w-4 transition-transform duration-200 ${isDismissed ? '' : 'group-hover:rotate-180 group-focus-within:rotate-180'}`}
        />
      </Link>
      <div
        className={`
          absolute top-full left-0 mt-0 w-56 bg-background border border-gray-200 dark:border-gray-700 rounded-md shadow-lg py-1
          opacity-0 invisible transition-[opacity,visibility] duration-200 ease-in-out z-50
          ${isDismissed ? '' : 'group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible'}
          ${isSubmenu ? 'left-full top-0 -mt-[2px] ml-0' : ''}
        `}
      > {/* -mt-[2px] to align better with parent item border */}
        {renderChildren(item.children)}
      </div>
    </div>
  );
}

export default function ResponsiveNav({
  homeLinkHref,
  navItems,
  canAccessCms,
  cmsDashboardLinkHref,
  isDraftModeEnabled,
  renderHeaderAuth,
  renderLanguageSwitcher,
  renderCurrencySwitcher,
  logo,
  siteTitle,
  renderCartIcon,
  isEcommerceActive = false,
}: ResponsiveNavProps) {
  const { t } = useTranslations();
  const label = useLabel();
  const pathname = usePathname() || '/';
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const wasMobileMenuOpenRef = useRef(false);
  const closeMenuLabel = label('close_main_menu', 'Close main menu', 'Fermer le menu principal');
  const [expandedMobileItems, setExpandedMobileItems] = useState<Record<string, boolean>>({});

  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const activeNavItems = useMemo(() => {
    if (isEcommerceActive) return navItems;
    return navItems.filter(item => {
      const href = item.url.toLowerCase();
      if (href.startsWith('/product') || href.startsWith('/checkout') || href.startsWith('/shop') || href.startsWith('/cart')) {
        return false;
      }
      return true;
    });
  }, [navItems, isEcommerceActive]);

  const hierarchicalNavItems = useMemo(() => buildHierarchy(activeNavItems), [activeNavItems]);
  const { currentContent } = useCurrentContent();

  let editPathDetails: { href: string; label: string } | null = null;
  let draftModeDetails: { href: string; label: string; ariaLabel: string } | null = null;

  if (canAccessCms && currentContent.id && currentContent.type) {
    if (currentContent.type === 'page') {
      editPathDetails = {
        href: `/cms/pages/${currentContent.id}/edit`,
        label: t('edit_page'),
      };
    } else if (currentContent.type === 'post') {
      editPathDetails = {
        href: `/cms/posts/${currentContent.id}/edit`,
        label: t('edit_post'),
      };
    } else if (currentContent.type === 'product') {
      editPathDetails = {
        href: `/cms/products/${currentContent.id}/edit`,
        label: t('edit_product'),
      };
    }
  }

  const canToggleDraftForCurrentContent =
    canAccessCms &&
    Boolean(currentContent.id) &&
    (currentContent.type === 'page' ||
      currentContent.type === 'post' ||
      currentContent.type === 'product') &&
    !pathname.startsWith('/cms');

  if (canToggleDraftForCurrentContent) {
    const draftRoute = isDraftModeEnabled ? '/api/draft/disable' : '/api/draft/start';
    draftModeDetails = {
      href: `${draftRoute}?path=${encodeURIComponent(pathname)}`,
      label: isDraftModeEnabled ? 'Exit Draft' : 'Draft',
      ariaLabel: isDraftModeEnabled
        ? 'Exit draft mode'
        : `Enable draft mode for this ${currentContent.type}`,
    };
  }
  // The old path-based logic for determining editPathDetails is removed
  // as the context is now the source of truth for ID and type.
  // The link will only show if canAccessCms is true and context provides valid id and type.

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
    // Optionally reset expanded submenus when main menu closes
    // if (!isMobileMenuOpen) setExpandedMobileItems({});
  };

  const toggleMobileSubmenu = (itemId: string) => {
    setExpandedMobileItems(prev => ({ ...prev, [itemId]: !prev[itemId] }));
  };

  useEffect(() => { // Added opening curly brace
    const handleResize = () => {
      if (window.innerWidth >= 768 && isMobileMenuOpen) { // Tailwind 'md' breakpoint is 768px
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobileMenuOpen]);

  useEffect(() => {
    const menuElement = menuContainerRef.current;
    if (!menuElement) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // The toggle sits outside the focus trap and the drawer has no close button of its
      // own, so without Escape a keyboard user could not leave the open menu.
      if (event.key === 'Escape') {
        setIsMobileMenuOpen(false);
        return;
      }

      if (event.key !== 'Tab') return;

      const focusableElements = menuElement.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), details, [tabindex]:not([tabindex="-1"])'
      );

      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey) {
        // Shift + Tab
        if (document.activeElement === firstElement) {
          lastElement.focus();
          event.preventDefault();
        }
      } else {
        // Tab
        if (document.activeElement === lastElement) {
          firstElement.focus();
          event.preventDefault();
        }
      }
    };

    if (isMobileMenuOpen) {
      const focusableElements = menuElement.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), details, [tabindex]:not([tabindex="-1"])'
      );
      
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      }
      
      document.addEventListener('keydown', handleKeyDown);
    } else if (wasMobileMenuOpenRef.current) {
      // Hand focus back only after a real close. This effect also runs on mount, where it
      // used to pull focus (and the scroll position) onto the hamburger on every page load.
      menuButtonRef.current?.focus({ preventScroll: true });
    }

    wasMobileMenuOpenRef.current = isMobileMenuOpen;

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobileMenuOpen]);

  // The page behind the scrim must not scroll while the drawer is open.
  useEffect(() => {
    if (!isMobileMenuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileMenuOpen]);

  const renderMobileNavItems = (items: HierarchicalNavigationItem[], level = 0): React.JSX.Element[] => {
    return items.map(item => (
      <div key={item.id} className={`${level > 0 ? 'ml-0' : ''}`}>
        <div
          className={`flex items-center justify-between w-full text-base font-medium text-foreground rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 ${level > 0 ? 'px-3 py-2' : 'px-3 py-2'}`}
        >
          {/* Only the label is a clickable link */}
          <Link
            href={item.url}
            className="py-0 px-0 mr-2 rounded-sm focus-visible:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              toggleMobileMenu();
            }}
          >
            {item.label}
          </Link>
          {/* If item has children, the rest of the row (whitespace + chevron) is a single button to toggle submenu */}
          {item.children && item.children.length > 0 && (
            <button
              type="button"
              className="flex flex-1 items-center h-full cursor-pointer bg-transparent border-none rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring px-1 justify-end"
              style={{ minWidth: 0 }}
              aria-expanded={!!expandedMobileItems[String(item.id)]}
              aria-label={label(
                'nav.toggle_submenu',
                'Toggle submenu for {label}',
                'Afficher ou masquer le sous-menu de {label}',
                { label: item.label }
              )}
              onClick={e => {
                e.stopPropagation();
                toggleMobileSubmenu(String(item.id));
              }}
            >
              <span className="flex-1" /> {/* whitespace filler, clickable */}
              <ChevronDownIcon className={`h-5 w-5 transform transition-transform duration-200 ${expandedMobileItems[String(item.id)] ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
        {item.children && item.children.length > 0 && expandedMobileItems[String(item.id)] && (
          <div className="pl-[calc(0.75rem+0.5rem)] mt-1 mb-1 border-l-2 border-gray-300 dark:border-gray-600 ml-[calc(0.75rem+1px)] mr-3">
            {renderMobileNavItems(item.children, level + 1)}
          </div>
        )}
      </div>
    ));
  };

  const renderDesktopNavItems = (items: HierarchicalNavigationItem[], isSubmenu = false): React.JSX.Element[] => {
    return items.map(item => (
      <DesktopNavItem
        key={item.id}
        item={item}
        isSubmenu={isSubmenu}
        renderChildren={(children) => renderDesktopNavItems(children, true)}
      />
    ));
  };

  return (
    <>
      {/* Main container for desktop and mobile top bar elements */}
      <div className="flex justify-between items-center w-full">
        {/* Left side: Home link (visible on desktop and mobile) */}
        <div className="flex items-center">
          <Link
            href={homeLinkHref}
            className="flex items-center space-x-2 rtl:space-x-reverse"
          >
            {logo && logo.media ? (
              <Image
                src={resolveMediaUrl(logo.media.object_key) || FALLBACK_LOGO_PATH}
                alt={logo.media.alt_text || siteTitle || 'Nextblock'}
                width={logo.media.width || 100}
                height={logo.media.height || 32}
                className="h-14 w-auto object-contain" style={{ width: 'auto', height: '56px' }}
                priority
              />
            ) : (
              <Image
                src={FALLBACK_LOGO_PATH}
                alt={siteTitle || 'Nextblock'}
                width={120}
                height={40}
                className="h-14 w-auto object-contain" style={{ width: 'auto', height: '56px' }}
                priority
              />
            )}
          </Link>
          {/* Desktop: Additional Nav items */}
          <div className="hidden md:flex items-baseline font-semibold ml-6 space-x-1"> {/* Adjusted space-x for items with internal padding */}
            {hierarchicalNavItems.length > 0 && renderDesktopNavItems(hierarchicalNavItems)}
          </div>
        </div>

        {/* Right side: Auth, LangSwitcher (desktop), Hamburger (mobile) */}
        <div className="hidden min-h-10 items-center gap-4 md:flex">
          {draftModeDetails && (
            <a
              href={draftModeDetails.href}
              aria-label={draftModeDetails.ariaLabel}
              className={`flex items-center rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                isDraftModeEnabled
                  ? 'bg-amber-500 text-white hover:bg-amber-600'
                  : 'text-foreground hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {isDraftModeEnabled ? (
                <EyeOff className="mr-2 h-4 w-4" />
              ) : (
                <FilePenLine className="mr-2 h-4 w-4" />
              )}
              {draftModeDetails.label}
            </a>
          )}
          {canAccessCms && editPathDetails && (
            <Link href={editPathDetails.href} className="hover:underline font-semibold text-sm text-foreground mr-3 flex items-center">
              <Pencil className="w-4 h-4 mr-2" />
              {editPathDetails.label}
            </Link>
          )}
          <ClientOnly>
            <DeferredGlobalSearch isEcommerceActive={isEcommerceActive} variant="desktop" />
            {renderHeaderAuth()}
            {renderLanguageSwitcher()}
            {renderCurrencySwitcher?.()}
            {renderCartIcon?.()}
          </ClientOnly>
        </div>

        <div className="md:hidden flex items-center gap-2 z-[60]">
          <ClientOnly>
            <DeferredGlobalSearch isEcommerceActive={isEcommerceActive} variant="mobile" />
          </ClientOnly>
          <button
            ref={menuButtonRef}
            onClick={toggleMobileMenu}
            className="p-2 rounded-md text-foreground hover:text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            aria-label={isMobileMenuOpen ? closeMenuLabel : t('open_main_menu')}
            aria-expanded={isMobileMenuOpen}
          >
            {isMobileMenuOpen ? (
              <svg className="h-6 w-6" stroke="currentColor" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-6 w-6" stroke="currentColor" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Overlay for Mobile Menu - Fades In/Out */}
      <div
        className={`fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity ease-in-out duration-300 top-16 md:hidden ${
          isMobileMenuOpen ? 'opacity-100 visible' : 'opacity-0 invisible'
        }`}
        onClick={toggleMobileMenu}
        aria-hidden={!isMobileMenuOpen}
      />

      {/* Slide-in Mobile Menu Container (for the sliding content) */}
      <div
        ref={menuContainerRef}
        // Closed, the drawer used to be merely translated off-screen: its links stayed in the
        // tab order and the dialog role stayed exposed. `visibility` transitions at the end of
        // the slide-out, and `inert` covers the 300 ms in between.
        className={`fixed inset-0 z-40 transform transition-[transform,visibility] ease-in-out duration-300 md:hidden ${
          isMobileMenuOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
        inert={!isMobileMenuOpen}
        role="dialog"
        aria-modal="true"
        aria-label={t('mobile_navigation_menu')}
      >
        {/* Menu Content (this part slides with the container above) */}
        <div className="fixed top-16 left-0 h-[calc(100dvh-4rem)] w-full max-w-sm bg-background text-foreground shadow-xl p-5 z-50 flex flex-col">
          <nav
            aria-label={t('mobile_navigation_menu')}
            className="flex-grow flex flex-col space-y-1 overflow-y-auto overscroll-contain pt-6"
          >
            <div className="space-y-1">
              {renderMobileNavItems(hierarchicalNavItems)}
            </div>
            
            {canAccessCms && (
              <div className="mt-auto space-y-1 border-t border-gray-200 dark:border-gray-800">
                {draftModeDetails && (
                  <a
                    href={draftModeDetails.href}
                    aria-label={draftModeDetails.ariaLabel}
                    className={`flex items-center rounded-md px-3 py-2 text-base font-medium ${
                      isDraftModeEnabled
                        ? 'bg-amber-500 text-white hover:bg-amber-600'
                        : 'text-foreground hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                    onClick={() => {
                      toggleMobileMenu();
                    }}
                  >
                    {isDraftModeEnabled ? (
                      <EyeOff className="mr-2 h-4 w-4" />
                    ) : (
                      <FilePenLine className="mr-2 h-4 w-4" />
                    )}
                    {draftModeDetails.label}
                  </a>
                )}
                {editPathDetails && (
                  <Link
                    href={editPathDetails.href}
                    className="flex items-center px-3 py-2 rounded-md text-base font-medium text-foreground hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => {
                      toggleMobileMenu();
                    }}
                  >
                    <Pencil className="w-4 h-4 mr-2" />
                    {editPathDetails.label}
                  </Link>
                )}
              </div>
            )}
          </nav>

          <div className="mt-auto pt-6 border-t border-foreground/20 space-y-4">
            <ClientOnly>
              <div>{renderHeaderAuth()}</div>
              <div>{renderCartIcon?.()}</div>
              <div>{renderCurrencySwitcher?.()}</div>
              <div>{renderLanguageSwitcher()}</div>
            </ClientOnly>
          </div>
        </div>
      </div>
    </>
  );
}
