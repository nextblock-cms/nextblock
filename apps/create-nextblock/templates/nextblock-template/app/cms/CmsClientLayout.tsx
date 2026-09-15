// app/cms/CmsClientLayout.tsx
"use client"

import React, { type ReactNode, useEffect } from "react"
import { useAuth } from "../../context/AuthContext"
import { useRouter, usePathname } from "next/navigation" // Import usePathname
import Link from "next/link"
import {
  LayoutDashboard, FileText, PenTool, Users, Settings, ChevronRight, LogOut, Menu, ListTree, Image as ImageIconLucide, X, Languages as LanguagesIconLucide, MessageSquare,
  Copyright as CopyrightIcon, ShoppingBag, ListOrdered, CreditCard, Package, Coins, MessageSquareText,
  ExternalLink, Paintbrush, Brain, TicketPercent, ShieldAlert, Folder, DatabaseBackup, Boxes, Tag,
  ShieldCheck, Code2, Cookie, LineChart, Mail, UserPlus, SlidersHorizontal, Search,
} from "lucide-react"
import TwoFactorReminderBanner from "./components/TwoFactorReminderBanner"
import SystemAlertsBanner, { type SystemAlertItem } from "./components/SystemAlertsBanner"
import PaymentsReminderBanner from "./components/PaymentsReminderBanner"
import ContactReminderBanner from "./components/ContactReminderBanner"
import type { PaymentsReminder } from "../../lib/cms/payments-reminder"
import type { ContactReminder } from "../../lib/cms/contact-reminder"
import { Button } from "@nextblock-cms/ui"
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui"
import { cn } from "@nextblock-cms/utils"
import { signOutAction } from "../actions"
import Image from "next/image";
import { FeedbackModal } from "./components/FeedbackModal";
import { CortexGlobalAgentChat } from "./components/CortexGlobalAgentChat";
import { CortexAiPageContextProvider } from "./components/CortexAiPageContext";
import { CortexAiActiveProvider } from "./components/CortexAiActiveContext";
import { EcommerceActiveProvider } from "./components/EcommerceActiveContext";
import { useAppBranding } from "../../components/AppShell";
import { resolveMediaUrl } from "../../lib/media/resolveMediaUrl";

const FALLBACK_LOGO_PATH = "/images/nextblock-logo-small.webp";

const LoadingSpinner = () => (
  <div className="flex justify-center items-center h-full w-full py-20">
    <div className="relative">
      <div className="h-16 w-16 rounded-full border-t-4 border-b-4 border-primary animate-spin"></div>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full bg-background"></div>
      </div>
    </div>
  </div>
);

type NavItemProps = {
  href: string
  icon: React.ElementType
  children: React.ReactNode
  isActive?: boolean
  adminOnly?: boolean
  writerOnly?: boolean
  /** Unread/needs-attention count rendered as a pill. */
  badgeCount?: number
  isAdmin?: boolean
  isWriter?: boolean
  onClick?: () => void
}

const NavItem = ({ href, icon: Icon, children, isActive, adminOnly, writerOnly, isAdmin, isWriter, onClick, badgeCount = 0 }: NavItemProps) => {
  if (adminOnly && !isAdmin) return null
  if (writerOnly && !isWriter && !isAdmin) return null

  return (
    <li>
      <Link
        href={href}
        onClick={onClick}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all",
          isActive
            ? "bg-primary/10 text-primary dark:bg-primary/20"
            : "text-slate-600 hover:text-primary hover:bg-primary/5 dark:text-slate-300 dark:hover:bg-primary/10",
        )}
      >
        <Icon className="h-5 w-5" />
        <span>{children}</span>
        {/* The badge and the chevron share ml-auto, so the count wins when there is one. */}
        {badgeCount > 0 ? (
          <span className="ml-auto rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-700 dark:text-amber-400">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        ) : (
          isActive && <ChevronRight className="h-4 w-4 ml-auto" />
        )}
      </Link>
    </li>
  )
};

type CollapsibleNavItemProps = {
  icon: React.ElementType
  title: string
  children: React.ReactNode
  isActive?: boolean
  adminOnly?: boolean
  isAdmin?: boolean
}

const CollapsibleNavItem = ({ icon: Icon, title, children, isActive, adminOnly, isAdmin }: CollapsibleNavItemProps) => {
  const [isOpen, setIsOpen] = React.useState(isActive);

  if (adminOnly && !isAdmin) return null

  return (
    <li>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all w-full",
          isActive
            ? "bg-primary/10 text-primary dark:bg-primary/20"
            : "text-slate-600 hover:text-primary hover:bg-primary/5 dark:text-slate-300 dark:hover:bg-primary/10",
        )}
      >
        <Icon className="h-5 w-5" />
        <span>{title}</span>
        <ChevronRight className={cn("h-4 w-4 ml-auto transition-transform", isOpen && "rotate-90")} />
      </button>
      {isOpen && (
        <ul className="pl-6 space-y-1.5 mt-1.5">
          {children}
        </ul>
      )}
    </li>
  )
};


export default function CmsClientLayout({
  children,
  isCortexAiActive = false,
  hasCortexModelKey = true,
  hasCortexSiteBrief = false,
  isEcommerceActive = false,
  showTwoFactorReminder = false,
  systemAlerts = [],
  paymentsReminder = null,
  messagesUnread = 0,
  contactReminder = null,
}: {
  children: ReactNode,
  isCortexAiActive?: boolean,
  /** The dashboard chat has an OpenRouter key (stored or env) to talk to. */
  hasCortexModelKey?: boolean,
  /** A site brief is saved, so the site builder opens with the plan, not the interview. */
  hasCortexSiteBrief?: boolean,
  isEcommerceActive?: boolean,
  showTwoFactorReminder?: boolean,
  systemAlerts?: SystemAlertItem[],
  paymentsReminder?: PaymentsReminder | null,
  messagesUnread?: number,
  contactReminder?: ContactReminder | null,
}) {
  const isSandbox = process.env.NEXT_PUBLIC_IS_SANDBOX === 'true';
  const { user, profile, role, isLoading, isAdmin, isWriter } = useAuth();
  const { logo, siteTitle } = useAppBranding();
  const router = useRouter();
  const pathname = usePathname(); // Use the usePathname hook
  const [cmsSidebarOpen, setCmsSidebarOpen] = React.useState(false);

  useEffect(() => {
    if (!isLoading) {
      if (!user) {
        router.push(`/sign-in?redirect=${encodeURIComponent(pathname || "/cms/dashboard")}`);
      } else if (!isWriter && !isAdmin) {
        router.push("/unauthorized?reason=insufficient_role_in_layout");
      }
    }
  }, [user, role, isLoading, router, isAdmin, isWriter, pathname]);

  useEffect(() => {
    const mainLayoutElement = document.querySelector('body > div > main > div.flex-1.w-full.flex.flex-col.items-center');
    if (mainLayoutElement) {
      mainLayoutElement.classList.remove('max-w-7xl');
      (mainLayoutElement as HTMLElement).style.padding = '0';
    }
     const mainScreenChild = document.querySelector('main.min-h-screen > div.flex-1.w-full');
     if (mainScreenChild) {
        mainScreenChild.classList.remove("max-w-7xl");
    }

    const handleResize = () => {
      if (window.innerWidth >= 768) {
        setCmsSidebarOpen(true);
      } else {
        // setCmsSidebarOpen(false); // Removed to allow manual toggle on mobile
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const closeSidebarOnMobile = () => {
    if (window.innerWidth < 768) {
      setCmsSidebarOpen(false);
    }
  };

  const handleSignOut = async () => {
    await signOutAction();
  };


  // With server-side auth data, isLoading is initially false.
  // We show a spinner only if something client-side sets it to true (e.g., during logout).
  if (isLoading) {
    return <LoadingSpinner />;
  }

  // The useEffect handles redirection if the server-provided user/role is insufficient.
  // Returning null here prevents rendering the layout for unauthorized users.
  if (!user || (!isWriter && !isAdmin)) {
    return null;
  }

  const getInitials = () => {
    if (profile && profile.full_name) return profile.full_name.split(' ').map((n: string) => n[0]).join('').substring(0,2).toUpperCase();
    if (user && user.email) return user.email.charAt(0).toUpperCase();
    return "U"; // Default fallback
  }
  const getRoleColor = () => {
    if (isAdmin) return "bg-amber-500";
    if (isWriter) return "bg-emerald-500";
    return "bg-sky-500"; // Default color
  }
  const cmsLogoSrc = resolveMediaUrl(logo?.media?.object_key) || FALLBACK_LOGO_PATH;
  const cmsLogoAlt = logo?.media?.alt_text || siteTitle || "Nextblock";

  // pageTitle logic should now work reliably with usePathname
  let pageTitle = "CMS"; // Default title
  if (pathname === "/cms/dashboard") pageTitle = "Dashboard";
  else if (pathname.startsWith("/cms/welcome")) pageTitle = "Welcome";
  else if (pathname.startsWith("/cms/custom-blocks/new")) pageTitle = "Create Custom Block";
  else if (pathname.startsWith("/cms/custom-blocks/") && pathname.endsWith("/edit")) pageTitle = "Edit Custom Block";
  else if (pathname.startsWith("/cms/custom-blocks")) pageTitle = "Block Management";
  else if (pathname.startsWith("/cms/pages/new")) pageTitle = "New Page";
  else if (pathname.startsWith("/cms/pages/") && pathname.endsWith("/edit")) pageTitle = "Edit Page";
  else if (pathname.startsWith("/cms/pages")) pageTitle = "Pages";
  else if (pathname.startsWith("/cms/posts/new")) pageTitle = "New Post";
  else if (pathname.startsWith("/cms/posts/") && pathname.endsWith("/edit")) pageTitle = "Edit Post";
  else if (pathname.startsWith("/cms/posts")) pageTitle = "Posts";
  else if (pathname.startsWith("/cms/navigation/new")) pageTitle = "New Navigation Item";
  else if (pathname.startsWith("/cms/navigation/") && pathname.includes("/edit")) pageTitle = "Edit Navigation Item";
  else if (pathname.startsWith("/cms/navigation")) pageTitle = "Navigation";
  else if (pathname.startsWith("/cms/media/") && pathname.endsWith("/edit")) pageTitle = "Edit Media Item";
  else if (pathname.startsWith("/cms/media")) pageTitle = "Media Library";
  else if (pathname.startsWith("/cms/users/") && pathname.endsWith("/edit")) pageTitle = "Edit User Profile";
  else if (pathname.startsWith("/cms/users")) pageTitle = "User Management";
  else if (pathname.startsWith("/cms/settings/languages/new")) pageTitle = "New Language";
  else if (pathname.startsWith("/cms/settings/languages") && pathname.includes("/edit")) pageTitle = "Edit Language";
  else if (pathname.startsWith("/cms/settings/languages")) pageTitle = "Language Settings";
  // Fallback for general /cms/settings if no more specific language path matches
  else if (pathname.startsWith("/cms/settings/logos")) pageTitle = "Branding";
  else if (pathname.startsWith("/cms/settings/copyright")) pageTitle = "Copyright Settings";
  else if (pathname.startsWith("/cms/settings/global-css")) pageTitle = "Themes & CSS";
  else if (pathname.startsWith("/cms/settings/site-scripts")) pageTitle = "Site Scripts";
  // Must stay ABOVE the generic "/cms/settings" arm below: this chain is
  // first-match-wins, so anything placed after that fallback is dead code.
  else if (pathname.startsWith("/cms/settings/seo")) pageTitle = "SEO & Redirects";
  else if (pathname.startsWith("/cms/settings/extra-translations")) pageTitle = "Extra Translations";
  else if (pathname.startsWith("/cms/settings/backup-restore")) pageTitle = "Backup And Restore";
  else if (pathname.startsWith("/cms/settings/currencies")) pageTitle = "Currency Settings";
  else if (pathname.startsWith("/cms/settings/taxes")) pageTitle = "Tax Settings";
  else if (pathname.startsWith("/cms/settings/cortex-ai")) pageTitle = "Cortex AI";
  else if (pathname.startsWith("/cms/settings/bot-protection")) pageTitle = "Bot Protection";
  else if (pathname.startsWith("/cms/settings/email")) pageTitle = "Email";
  else if (pathname.startsWith("/cms/settings/registration")) pageTitle = "Sign-ups & Registration";
  else if (pathname.startsWith("/cms/settings/google-analytics")) pageTitle = "Google Analytics";
  else if (pathname.startsWith("/cms/settings/privacy")) pageTitle = "Privacy & Consent";
  else if (pathname.startsWith("/cms/settings/security")) pageTitle = "Security & 2FA";
  else if (pathname.startsWith("/cms/payments")) pageTitle = "Payment Settings";

  else if (pathname.startsWith("/cms/settings/packages")) pageTitle = "Packages";
  else if (pathname.startsWith("/cms/settings")) pageTitle = "Settings";
  else if (pathname.startsWith("/cms/interactions")) pageTitle = "Interactions";
  else if (pathname.startsWith("/cms/products/inventory")) pageTitle = "Inventory";
  else if (pathname.startsWith("/cms/coupons/") && pathname.endsWith("/edit")) pageTitle = "Edit Coupon";
  else if (pathname.startsWith("/cms/coupons")) pageTitle = "Coupons";
  else if (pathname.startsWith("/cms/products/new")) pageTitle = "New Product";
  else if (pathname.startsWith("/cms/products/") && pathname.endsWith("/edit")) pageTitle = "Edit Product";
  else if (pathname.startsWith("/cms/products")) pageTitle = "Products";
  else if (pathname.startsWith("/cms/orders/") && pathname.endsWith("/edit")) pageTitle = "Edit Order";
  else if (pathname.startsWith("/cms/orders")) pageTitle = "Orders";
  else if (pathname.startsWith("/cms/messages")) pageTitle = "Messages";


  return (
    <CortexAiPageContextProvider>
      <CortexAiActiveProvider isActive={isCortexAiActive}>
      <EcommerceActiveProvider isActive={isEcommerceActive}>
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-slate-50 dark:bg-slate-950 md:flex-row">
      <div className="fixed bottom-4 right-4 z-[60] md:hidden">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setCmsSidebarOpen(!cmsSidebarOpen)}
          className="bg-white shadow-lg dark:bg-slate-800 rounded-full h-12 w-12"
        >
          {cmsSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </div>

      <aside
        className={cn(
          "fixed left-0 top-16 bottom-0 w-64 bg-white shadow-lg transition-transform duration-300 ease-in-out dark:bg-slate-900 dark:border-r dark:border-slate-700/60",
          "md:sticky md:top-0 md:bottom-auto md:h-full md:translate-x-0",
          cmsSidebarOpen ? "translate-x-0" : "-translate-x-full",
          "z-30"
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="p-4 border-b dark:border-slate-700/60 h-16 flex items-center shrink-0">
            <Link href="/cms/dashboard" className="flex items-center gap-2 px-2">
              <Image
                src={cmsLogoSrc}
                alt={cmsLogoAlt}
                width={logo?.media?.width || 32}
                height={logo?.media?.height || 32}
                className="h-8 w-auto"
                priority
              />
              <h2 className="text-xl font-bold text-foreground">
                Nextblock CMS
              </h2>
            </Link>
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
            <ul className="space-y-1.5">
              <NavItem href="/cms/dashboard" icon={LayoutDashboard} isActive={pathname === "/cms/dashboard"} isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                Dashboard
              </NavItem>
              {isCortexAiActive && (
                <NavItem href="/cms/settings/cortex-ai" icon={Brain} isActive={pathname.startsWith("/cms/settings/cortex-ai")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                        Cortex AI
                </NavItem>
              )}
              <NavItem href="/cms/pages" icon={FileText} isActive={pathname.startsWith("/cms/pages")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                Pages
              </NavItem>
              <NavItem href="/cms/posts" icon={PenTool} isActive={pathname.startsWith("/cms/posts")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                Posts
              </NavItem>
              <NavItem href="/cms/media" icon={ImageIconLucide} isActive={pathname.startsWith("/cms/media")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                Media
              </NavItem>
              <NavItem href="/cms/custom-blocks" icon={Boxes} isActive={pathname.startsWith("/cms/custom-blocks")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                Blocks
              </NavItem>
              <NavItem href="/cms/messages" icon={MessageSquareText} isActive={pathname.startsWith("/cms/messages")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile} badgeCount={messagesUnread}>
                Messages
              </NavItem>
              <NavItem href="/cms/navigation" icon={ListTree} isActive={pathname.startsWith("/cms/navigation")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                    Navigation
              </NavItem>
              {!isSandbox && (
                <NavItem href="/cms/settings/security" icon={ShieldCheck} isActive={pathname.startsWith("/cms/settings/security")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                  Security
                </NavItem>
              )}

              {isEcommerceActive && (
                <>
                  <div className="mt-6 mb-2">
                    <p className="px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">
                      Store
                    </p>
                  </div>
                  <CollapsibleNavItem
                    icon={ShoppingBag}
                    title="Products"
                    isActive={pathname.startsWith("/cms/products")}
                  >
                    <NavItem href="/cms/products" icon={ShoppingBag} isActive={pathname === "/cms/products" || (pathname.startsWith("/cms/products/") && !pathname.startsWith("/cms/products/categories") && !pathname.startsWith("/cms/products/attributes") && !pathname.startsWith("/cms/products/inventory"))} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                      All Products
                    </NavItem>
                    <NavItem href="/cms/products/categories" icon={Folder} isActive={pathname.startsWith("/cms/products/categories")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                      Categories
                    </NavItem>
                    <NavItem href="/cms/products/inventory" icon={Package} isActive={pathname.startsWith("/cms/products/inventory")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                      Inventory
                    </NavItem>
                    <NavItem href="/cms/products/attributes" icon={ListTree} isActive={pathname.startsWith("/cms/products/attributes")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                      Attributes
                    </NavItem>
                  </CollapsibleNavItem>
                  <NavItem href="/cms/orders" icon={ListOrdered} isActive={pathname.startsWith("/cms/orders")} writerOnly isAdmin={isAdmin} isWriter={isWriter} onClick={closeSidebarOnMobile}>
                    Orders
                  </NavItem>

                  <NavItem href="/cms/coupons" icon={TicketPercent} isActive={pathname.startsWith("/cms/coupons")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                    Coupons
                  </NavItem>
                  <NavItem href="/cms/promotions" icon={Tag} isActive={pathname.startsWith("/cms/promotions")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                    Bulk Price & Sales
                  </NavItem>
                  <CollapsibleNavItem
                    icon={SlidersHorizontal}
                    title="Configuration"
                    isActive={
                      pathname.startsWith("/cms/payments") ||
                      pathname.startsWith("/cms/shipping") ||
                      pathname.startsWith("/cms/settings/taxes") ||
                      pathname.startsWith("/cms/settings/currencies")
                    }
                    adminOnly
                    isAdmin={isAdmin}
                  >
                    <NavItem href="/cms/payments" icon={CreditCard} isActive={pathname.startsWith("/cms/payments")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Payments
                    </NavItem>
                    <NavItem href="/cms/shipping" icon={Package} isActive={pathname.startsWith("/cms/shipping")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Shipping
                    </NavItem>
                    <NavItem href="/cms/settings/taxes" icon={Settings} isActive={pathname.startsWith("/cms/settings/taxes")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Taxes
                    </NavItem>
                    <NavItem href="/cms/settings/currencies" icon={Coins} isActive={pathname.startsWith("/cms/settings/currencies")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Currencies
                    </NavItem>
                  </CollapsibleNavItem>
                </>
              )}

              {isAdmin && (
                <>
                  <div className="mt-6 mb-2">
                    <p className="px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider dark:text-slate-400">
                      Administration
                    </p>
                  </div>
                  <NavItem href="/cms/users" icon={Users} isActive={pathname.startsWith("/cms/users")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                    Manage Users
                  </NavItem>
                  <NavItem href="/cms/settings/packages" icon={Package} isActive={pathname.startsWith("/cms/settings/packages")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                    Packages
                  </NavItem>
                  <CollapsibleNavItem
                    icon={Settings}
                    title="Settings"
                    isActive={pathname.startsWith("/cms/settings") && !pathname.startsWith("/cms/settings/taxes") && !pathname.startsWith("/cms/settings/currencies") && !pathname.startsWith("/cms/settings/email") && !pathname.startsWith("/cms/settings/registration") && !pathname.startsWith("/cms/settings/bot-protection")}
                    adminOnly
                    isAdmin={isAdmin}
                  >
                    <NavItem href="/cms/settings/languages" icon={LanguagesIconLucide} isActive={pathname.startsWith("/cms/settings/languages")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Languages
                   </NavItem>
                   <NavItem href="/cms/settings/logos" icon={ImageIconLucide} isActive={pathname.startsWith("/cms/settings/logos")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                     Branding
                   </NavItem>
                    <NavItem href="/cms/settings/copyright" icon={CopyrightIcon} isActive={pathname.startsWith("/cms/settings/copyright")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Copyright
                    </NavItem>
                    <NavItem href="/cms/settings/global-css" icon={Paintbrush} isActive={pathname.startsWith("/cms/settings/global-css")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Themes &amp; CSS
                    </NavItem>
                    <NavItem href="/cms/settings/site-scripts" icon={Code2} isActive={pathname.startsWith("/cms/settings/site-scripts")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Site Scripts
                    </NavItem>
                    <NavItem href="/cms/settings/privacy" icon={Cookie} isActive={pathname.startsWith("/cms/settings/privacy")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Privacy &amp; Consent
                    </NavItem>
                    <NavItem href="/cms/settings/google-analytics" icon={LineChart} isActive={pathname.startsWith("/cms/settings/google-analytics")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Google Analytics
                    </NavItem>
                    <NavItem href="/cms/settings/seo" icon={Search} isActive={pathname.startsWith("/cms/settings/seo")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      SEO &amp; Redirects
                    </NavItem>
                    <NavItem href="/cms/settings/extra-translations" icon={MessageSquare} isActive={pathname.startsWith("/cms/settings/extra-translations")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Extra Translations
                    </NavItem>
                    <NavItem href="/cms/settings/backup-restore" icon={DatabaseBackup} isActive={pathname.startsWith("/cms/settings/backup-restore")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Backup / Restore
                    </NavItem>
                 </CollapsibleNavItem>
                  <CollapsibleNavItem
                    icon={SlidersHorizontal}
                    title="Configuration"
                    isActive={
                      pathname.startsWith("/cms/settings/email") ||
                      pathname.startsWith("/cms/settings/registration") ||
                      pathname.startsWith("/cms/settings/bot-protection")
                    }
                    adminOnly
                    isAdmin={isAdmin}
                  >
                    <NavItem href="/cms/settings/email" icon={Mail} isActive={pathname.startsWith("/cms/settings/email")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Email
                    </NavItem>
                    <NavItem href="/cms/settings/bot-protection" icon={ShieldAlert} isActive={pathname.startsWith("/cms/settings/bot-protection")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Bot Protection
                    </NavItem>
                    <NavItem href="/cms/settings/registration" icon={UserPlus} isActive={pathname.startsWith("/cms/settings/registration")} adminOnly isAdmin={isAdmin} onClick={closeSidebarOnMobile}>
                      Sign-ups
                    </NavItem>
                 </CollapsibleNavItem>
                </>
              )}
            </ul>
          </nav>


          <div className="p-3 pb-0">
             <FeedbackModal />
          </div>

          <div className="mt-auto p-3 border-t border-slate-200 dark:border-slate-700/60 shrink-0">
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10 border">
                <AvatarImage src={profile?.avatar_url || undefined} alt={profile?.full_name || user?.email} />
                <AvatarFallback className="bg-primary/10 text-primary font-medium">{getInitials()}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate text-slate-700 dark:text-slate-200">{profile?.full_name || user?.email}</p>
                <div className="flex items-center gap-1.5">
                  <div className={cn("h-2 w-2 rounded-full", getRoleColor())}></div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 capitalize">{role}</p>
                </div>
              </div>
              <Button onClick={handleSignOut} variant="ghost" size="icon" className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300" title="Sign Out">
                  <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col transition-all duration-300 ease-in-out w-full min-h-0">
        <header className="bg-background dark:bg-slate-800/30 border-b border-border h-16 flex items-center gap-3 px-6 sticky top-0 z-20 w-full shrink-0">
            <Button variant="ghost" size="icon" className="md:hidden mr-3 -ml-2" onClick={() => setCmsSidebarOpen(!cmsSidebarOpen)}>
                <Menu className="h-5 w-5" />
            </Button>
           <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">
              {pageTitle}
            </h1>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link href="/" target="_blank">
                <ExternalLink className="h-4 w-4" />
                <span className="hidden sm:inline">View Site</span>
              </Link>
            </Button>
        </header>
        <main className="flex-1 min-h-0 w-full overflow-y-auto overscroll-contain px-6 pt-6 pb-20 scroll-pb-24 md:pb-24">
            {showTwoFactorReminder && <TwoFactorReminderBanner />}
            {paymentsReminder && <PaymentsReminderBanner reminder={paymentsReminder} />}
            {contactReminder && <ContactReminderBanner reminder={contactReminder} />}
            <SystemAlertsBanner alerts={systemAlerts} />
            {children}
        </main>
      </div>
      {cmsSidebarOpen && ! (typeof window !== 'undefined' && window.innerWidth >= 768) && (
        <div
            className="fixed inset-x-0 bottom-0 top-16 bg-black/30 z-20 md:hidden"
            onClick={() => setCmsSidebarOpen(false)}
        />
      )}
      {isAdmin && isCortexAiActive && (
        <CortexGlobalAgentChat hasModelKey={hasCortexModelKey} hasSiteBrief={hasCortexSiteBrief} />
      )}
    </div>
      </EcommerceActiveProvider>
      </CortexAiActiveProvider>
    </CortexAiPageContextProvider>
  )
}
