'use client';

import { AccountNavigationMenu } from '@nextblock-cms/ecommerce';
import { useTranslations } from '@nextblock-cms/utils';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@nextblock-cms/ui';
import { User as UserIcon } from 'lucide-react';

import type { ProfileAccountSummary, ProfileAccountUser } from './account-types';
import { profileAccountLinks } from './account-links';

interface ProfileAccountSidebarProps {
  profile: ProfileAccountSummary;
  user: ProfileAccountUser;
}

export function ProfileAccountSidebar({
  profile,
  user,
}: ProfileAccountSidebarProps) {
  const { t } = useTranslations();
  const displayName =
    profile.full_name || user.email || 'User';

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-xl">
          {t('public_profile') === 'public_profile'
            ? 'Public Profile'
            : t('public_profile')}
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col items-center space-y-4 text-center">
        <Avatar className="h-28 w-28 border-4 border-muted">
          <AvatarImage
            src={profile.avatar_url || undefined}
            alt={displayName}
            className="object-cover"
          />
          <AvatarFallback className="bg-secondary text-3xl">
            {displayName?.charAt(0)?.toUpperCase() || (
              <UserIcon className="h-10 w-10" />
            )}
          </AvatarFallback>
        </Avatar>

        <div className="w-full space-y-1 text-left">
          <div className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            {t('identity') === 'identity' ? 'Identity' : t('identity')}
          </div>
          <p className="text-lg font-semibold">{displayName}</p>
          {user.email ? (
            <p className="break-all text-sm text-muted-foreground">{user.email}</p>
          ) : null}
        </div>

        <AccountNavigationMenu
          links={profileAccountLinks}
          className="text-left"
        />
      </CardContent>
    </Card>
  );
}
