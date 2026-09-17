'use client';

import { useTranslations } from '@nextblock-cms/utils';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@nextblock-cms/ui';

import type { ProfileAccountSummary, ProfileAccountUser } from '../account-types';
import { ProfileAccountSidebar } from '../ProfileAccountSidebar';
import { SubmitButton } from '../../../components/submit-button';
import { changePasswordAction } from './actions';

interface PasswordSettingsPageClientProps {
  profile: ProfileAccountSummary;
  user: ProfileAccountUser;
  successMessage?: string | null;
  errorMessage?: string | null;
}

function translateMessage(
  t: (key: string, params?: Record<string, string | number>) => string,
  value?: string | null
) {
  if (!value) {
    return null;
  }

  const translated = t(value);
  return translated === value ? value : translated;
}

export function PasswordSettingsPageClient({
  profile,
  user,
  successMessage,
  errorMessage,
}: PasswordSettingsPageClientProps) {
  const { t } = useTranslations();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-6">
      <div className="grid gap-6 md:grid-cols-12">
        <div className="md:col-span-4">
          <ProfileAccountSidebar profile={profile} user={user} />
        </div>

        <Card className="md:col-span-8">
          <form action={changePasswordAction}>
            <CardHeader>
              {/* CardTitle is a <div>, so the page had no h1. A real <h1> would pick up the
                  global heading margins; the role keeps the card layout unchanged. */}
              <CardTitle role="heading" aria-level={1}>
                {t('profile_password_title') === 'profile_password_title'
                  ? 'Change your password'
                  : t('profile_password_title')}
              </CardTitle>
              <CardDescription>
                {t('profile_password_description') ===
                'profile_password_description'
                  ? 'Update your account password without leaving your profile.'
                  : t('profile_password_description')}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="password">
                    {t('new_password') === 'new_password'
                      ? 'New password'
                      : t('new_password')}
                  </Label>
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">
                    {t('confirm_new_password') === 'confirm_new_password'
                      ? 'Confirm new password'
                      : t('confirm_new_password')}
                  </Label>
                  <Input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                  />
                </div>
              </div>

              {successMessage ? (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  {translateMessage(t, successMessage)}
                </div>
              ) : null}

              {errorMessage ? (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {translateMessage(t, errorMessage)}
                </div>
              ) : null}
            </CardContent>

            <CardFooter className="flex justify-end">
              {/* useFormStatus-backed: the plain button gave no feedback while the action ran,
                  which invited a second submit. */}
              <SubmitButton size="lg" pendingText={t('saving') === 'saving' ? 'Saving…' : t('saving')}>
                {t('save_changes') === 'save_changes'
                  ? 'Save changes'
                  : t('save_changes')}
              </SubmitButton>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
