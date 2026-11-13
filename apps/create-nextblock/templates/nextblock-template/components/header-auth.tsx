'use client';

import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui";
import { Button } from "@nextblock-cms/ui";
import { signOutAction } from "../app/actions";
import { useAuth } from "../context/AuthContext";
import { clearSandboxCortexKey } from "../lib/cortex-ai/sandbox-headers";
import { useTranslations } from "@nextblock-cms/utils";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@nextblock-cms/ui";
import { User, LogOut, LayoutDashboard, Store } from "lucide-react";

const PARTNER_PORTAL_PATH = "/portal/retailer";

export default function AuthButton() {
  const { user, profile, isAdmin, isWriter, isRetailer, isPartnerPortalActive } = useAuth();
  const { lang, t } = useTranslations();
  const displayName = profile?.full_name || user?.email || null;
  // `t()` answers an unseeded key with the key itself, so `t('profile') || 'Profile'` rendered
  // the literal "profile". Neither key below is seeded yet.
  const label = (key: string, en: string, fr: string) => {
    const translated = t(key);
    return translated !== key ? translated : lang.toLowerCase().startsWith('fr') ? fr : en;
  };
  const accountMenuLabel = label('account_menu', 'Account menu', 'Menu du compte');
  const showAdminLink = isAdmin || isWriter;

  const handleSignOut = async () => {
    // The sandbox's demo accounts are shared: forget the visitor's own OpenRouter key first.
    clearSandboxCortexKey();
    await signOutAction();
  };

  return user ? (
    <div className="flex items-center gap-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="relative h-8 w-8 rounded-full p-0"
            aria-label={displayName ? `${accountMenuLabel}: ${displayName}` : accountMenuLabel}
          >
            <Avatar className="h-8 w-8 transition-shadow hover:ring-1 hover:ring-primary">
              <AvatarImage src={profile?.avatar_url || undefined} alt={displayName || 'User'} />
              <AvatarFallback className="bg-muted">
                {displayName ? displayName.charAt(0).toUpperCase() : <User className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="end" forceMount>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">{displayName || 'User'}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/profile" className="cursor-pointer">
              <User className="mr-2 h-4 w-4" />
              <span>{label('profile', 'Profile', 'Profil')}</span>
            </Link>
          </DropdownMenuItem>
          {showAdminLink && (
             <DropdownMenuItem asChild>
              <Link href="/cms/dashboard" className="cursor-pointer">
                <LayoutDashboard className="mr-2 h-4 w-4" />
                <span>{t('cms_dashboard')}</span>
              </Link>
            </DropdownMenuItem>
          )}
          {/* Partner portal. Prefetch is off: the portal renders per partner, and a menu item
              that is mounted while hidden must not make the server render it on every page.
              Hidden while the Affiliates package is inactive (the portal sends partners home). */}
          {isRetailer && isPartnerPortalActive && (
            <DropdownMenuItem asChild>
              <Link href={PARTNER_PORTAL_PATH} prefetch={false} className="cursor-pointer">
                <Store className="mr-2 h-4 w-4" aria-hidden="true" />
                <span>{label('partner_portal', 'Partner portal', 'Portail partenaire')}</span>
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut} className="cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              <span>{t('sign_out')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : (
    <div className="flex gap-2">
      <Button asChild size="sm" variant={"outline"}>
        <Link href="/sign-in">{t('sign_in')}</Link>
      </Button>
      <Button asChild size="sm" variant={"default"}>
        <Link href="/sign-up">{t('sign_up')}</Link>
      </Button>
    </div>
  );
}
