'use client';

import { signInAction } from "../../actions";
import { FormMessage, Message } from "../../../components/form-message";
import { SubmitButton } from "../../../components/submit-button";
import { Input, Label } from "@nextblock-cms/ui";
import Link from "next/link";
import { useTranslations } from "@nextblock-cms/utils";
import { useSearchParams } from "next/navigation";

import { SandboxCredentialsAlert } from "../../../components/SandboxCredentialsAlert";

function getMessage(searchParams: URLSearchParams): Message | undefined {
    if (searchParams.has('error')) {
        const error = searchParams.get('error');
        if (error) return { error };
    }
    if (searchParams.has('success')) {
        const success = searchParams.get('success');
        if (success) return { success };
    }
    if (searchParams.has('message')) {
        const message = searchParams.get('message');
        if (message) return { message };
    }
    return undefined;
}

export default function Login() {
  const { t } = useTranslations();
  const searchParams = useSearchParams();
  const formMessage = getMessage(searchParams);
  const redirectParam = searchParams.get('redirect');

  return (
    <div className="flex-1 flex flex-col w-full max-w-160 mx-auto">
      <SandboxCredentialsAlert />
      <h1 className="text-2xl font-medium">{t('sign_in')}</h1>
      <p className="text-sm text-foreground">
        {t('dont_have_account')}{" "}
        <Link className="text-foreground font-medium underline transition-colors hover:text-primary" href="/sign-up">
          {t('sign_up')}
        </Link>
      </p>

      <div className="flex flex-col gap-2 mt-8">
        <form className="flex flex-col gap-2 [&>input]:mb-3">
          {redirectParam && <input type="hidden" name="redirect" value={redirectParam} />}
          <Label htmlFor="email">{t('email')}</Label>
          <Input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={t('you_at_example_com')}
            required
          />
          <div className="flex justify-between items-center">
            <Label htmlFor="password">{t('password')}</Label>
            {process.env.NEXT_PUBLIC_IS_SANDBOX !== 'true' && <Link
              className="text-xs text-foreground underline transition-colors hover:text-primary"
              href="/forgot-password"
            >
              {t('forgot_password')}
            </Link>}
          </div>
          <Input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder={t('your_password')}
            required
          />
          <label className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              name="remember_device"
              className="h-4 w-4 rounded border-input accent-primary"
            />
            {t('remember_this_device') || 'Remember this device'}
          </label>
          <SubmitButton pendingText={t('signing_in_pending')} formAction={signInAction}>
            {t('sign_in')}
          </SubmitButton>
          <FormMessage message={formMessage} />
        </form>
      </div>
    </div>
  );
}
